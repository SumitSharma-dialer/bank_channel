'use strict';
// SIP registration view: outbound (trunk -> carrier) and inbound (customer -> us) per trunk / process.
// Parsers are pure (unit tested); collect() runs the Asterisk CLI, reads the log and the live trace buffer.
const { execFile } = require('child_process');
const fs = require('fs/promises');
const cfg = require('../config');
const { q } = require('../db');

// `pjsip show registrations`:  " t_x-reg/sip:1.2.3.4:5060   t_x-auth   Registered   (exp. 3245s)"
function parseRegistrations(out) {
  const r = {};
  for (const line of String(out || '').split('\n')) {
    const m = /^\s*t_([a-z0-9_]+)-reg\/(\S+)\s+(\S+)\s+(\w+)(?:\s+\(exp\.\s*(-?\d+)s\))?/.exec(line);
    if (m) r[m[1]] = { serverUri: m[2], status: m[4], expiresIn: m[5] != null ? +m[5] : null };
  }
  return r;
}

// `database show registrar`: "/registrar/contact/p_x;@hash  : {json}" (contacts customers registered with us)
function parseRegistrar(out) {
  const r = {};
  for (const line of String(out || '').split('\n')) {
    const m = /^\/registrar\/contact\/(p_[a-z0-9_]+);@\S+\s*:\s*(\{.*\})\s*$/.exec(line.trim());
    if (!m) continue;
    let j; try { j = JSON.parse(m[2]); } catch { continue; }
    const host = /^\[?([0-9a-fA-F.:]+?)\]?(?::(\d+))?(?:[;>]|$)/.exec(String(j.uri || '').replace(/^sips?:([^@]*@)?/, ''));
    (r[m[1].slice(2)] = r[m[1].slice(2)] || []).push({
      uri: j.uri || '', ip: j.via_addr || (host && host[1]) || '', port: +(j.via_port || (host && host[2]) || 0) || null,
      userAgent: j.user_agent || '', expiresAt: j.expiration_time ? +j.expiration_time * 1000 : null,
    });
  }
  return r;
}

// last Asterisk log line about registration that mentions any of the needles
const REG_LOG_RE = /regist/i;
function lastLogLine(lines, needles) {
  const ns = needles.filter((n) => n && String(n).length >= 3).map((n) => String(n).toLowerCase());
  if (!ns.length) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!REG_LOG_RE.test(l) || /TNAuthList|Registered object|Registered (?:custom|application|module)/i.test(l)) continue;
    const low = l.toLowerCase();
    if (ns.some((n) => low.includes(n))) {
      const lv = (/\]\s+([A-Z]+)\[/.exec(l) || [])[1] || '';
      return { line: l.length > 400 ? l.slice(0, 400) + '…' : l, level: lv, at: (/^\[([^\]]+)\]/.exec(l) || [])[1] || '' };
    }
  }
  return null;
}

const cli = (cmd) => new Promise((resolve) => {
  execFile('asterisk', ['-rx', cmd], { timeout: 4000, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? '' : out));
});
async function logTail(bytes = 4 * 1024 * 1024) {
  let fh;
  try {
    fh = await fs.open(cfg.asterisk.log, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, bytes), buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8').split('\n');
  } catch { return []; } finally { if (fh) await fh.close(); }
}

// last REGISTER request / response in the live trace buffer that involves one of the IPs or users
function lastPacket(log, ips, users) {
  if (!log) return null;
  const ipSet = new Set(ips.filter(Boolean)), userSet = new Set(users.filter(Boolean));
  for (let i = log.list.length - 1; i >= 0; i--) {
    const e = log.list[i];
    if (e.type !== 'register') continue;
    const hit = [e.src, e.dst].some((x) => ipSet.has(String(x).replace(/:\d+$/, ''))) || userSet.has(e.from) || userSet.has(e.to);
    if (hit) return { label: e.label, ts: e.ts, src: e.src, dst: e.dst, callId: e.callId };
  }
  return null;
}

async function collect(traceLog) {
  const [trunks, procs, regOut, dbOut, lines] = await Promise.all([
    // only whether a password exists, never the password itself
    q(`SELECT name, host, port, register, username, (coalesce(password,'') <> '') AS has_pass, active FROM trunks ORDER BY name`),
    q('SELECT code, name, auth_type, sip_username, allowed_ips, active FROM processes ORDER BY code'),
    cli('pjsip show registrations'), cli('database show registrar'), logTail(),
  ]);
  const outReg = parseRegistrations(regOut), inReg = parseRegistrar(dbOut);
  const now = Date.now();
  const rows = [];
  for (const t of trunks.rows) {
    const hasAuth = !!(t.username && t.has_pass);   // same rule as renderTrunks()
    const expected = !!(t.active && t.register && hasAuth);
    const why = !t.active ? 'trunk inactive' : !t.register ? '"Register" is off — carrier authenticates by IP'
      : !hasAuth ? '"Register" is on but no username/password is set, so Asterisk sends no REGISTER' : '';
    const r = outReg[t.name];
    const state = !expected ? 'NOT USED' : !r ? 'NOT LOADED' : /^registered$/i.test(r.status) ? 'REGISTERED' : r.status.toUpperCase();
    const hint = state === 'NOT LOADED' ? 'Asterisk has no registration for this trunk — System → Re-apply config'
      : state === 'REJECTED' ? 'Carrier refused the REGISTER (wrong username/password, or IP not allowed) — see the last log line / trace'
        : state === 'UNREGISTERED' ? 'No successful REGISTER yet (no reply or retrying) — trace it to see the carrier\'s answer' : '';
    rows.push({ kind: 'trunk', name: t.name, direction: 'out', who: `${t.username || '—'} → ${t.host}:${t.port || 5060}`,
      target: `trunk:${t.name}`, expected, why: why || hint, state, expiresIn: r && r.expiresIn, serverUri: r && r.serverUri,
      contacts: [], lastLog: lastLogLine(lines, [`t_${t.name}`, t.host]), lastPacket: lastPacket(traceLog, [t.host], [t.username]) });
  }
  for (const p of procs.rows) {
    const byPass = p.auth_type !== 'ip';
    const contacts = (inReg[p.code] || []).map((c) => ({ ...c, expiresIn: c.expiresAt ? Math.round((c.expiresAt - now) / 1000) : null }));
    const live = contacts.filter((c) => c.expiresIn == null || c.expiresIn > 0);
    const state = !byPass ? 'NOT USED' : live.length ? 'REGISTERED' : 'NOT REGISTERED';
    const ips = byPass ? live.map((c) => c.ip) : String(p.allowed_ips || '').split(/[\s,]+/);
    rows.push({ kind: 'process', name: p.code, label: p.name, direction: 'in', who: byPass ? `${p.sip_username} → this server` : `IP ${p.allowed_ips || '—'}`,
      target: `process:${p.code}`, expected: byPass && p.active,
      why: !byPass ? 'IP authentication — the customer does not register' : !p.active ? 'process inactive'
        : !live.length ? 'The customer server has not registered (or its registration expired) — check its sip.conf/pjsip.conf register line' : '',
      state, expiresIn: live.length ? Math.min(...live.map((c) => c.expiresIn ?? Infinity)) : null, contacts,
      lastLog: lastLogLine(lines, [`p_${p.code}`, byPass ? `${p.sip_username}@` : '', `'${p.sip_username}'`]),
      lastPacket: lastPacket(traceLog, ips, byPass ? [p.sip_username] : []) });
  }
  return { at: now, rows };
}

// cheap per-process view for the Processes page: code -> live (not expired) registered contacts
async function registered() {
  const now = Date.now(), out = {};
  for (const [code, list] of Object.entries(parseRegistrar(await cli('database show registrar')))) {
    const live = list.map(({ ip, port, userAgent, expiresAt }) => ({ ip, port, userAgent, expiresIn: expiresAt ? Math.round((expiresAt - now) / 1000) : null }))
      .filter((c) => c.expiresIn == null || c.expiresIn > 0);
    if (live.length) out[code] = live;
  }
  return out;
}

module.exports = { collect, registered, parseRegistrations, parseRegistrar, lastLogLine, lastPacket };
