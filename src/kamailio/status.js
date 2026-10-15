'use strict';
// Kamailio views in the shapes the rest of the app already uses for Asterisk (src/diag/reg.js, src/tracker.js).
// Parsers are pure (unit tested).
const { rpc } = require('./rpc');

const hostPort = (uri) => {
  const m = /^sips?:(?:[^@]*@)?\[?([0-9a-fA-F.:]+?)\]?(?::(\d+))?(?:;|$)/.exec(String(uri || ''));
  return m ? { ip: m[1], port: +(m[2] || 5060) } : { ip: '', port: null };
};

// dispatcher.list -> [{ duid, uri, up, rtt }]. FLAGS: A active, T trying (still used), I inactive, D disabled; P = pinged
function parseDispatcher(res) {
  const out = [];
  for (const rec of (res && res.RECORDS) || []) {
    for (const t of (rec.SET && rec.SET.TARGETS) || []) {
      const d = t.DEST || {};
      const flags = String(d.FLAGS || '');
      const lat = d.LATENCY || (d.ATTRS && d.ATTRS.LATENCY) || {};
      out.push({ set: rec.SET.ID, duid: (d.ATTRS && d.ATTRS.DUID) || '', uri: d.URI || '', up: flags[0] === 'A' || flags[0] === 'T',
        checked: flags[1] === 'P' || flags[0] === 'I', rtt: Number.isFinite(+lat.AVG) && +lat.AVG > 0 ? Math.round(+lat.AVG * 10) / 10 : null });
    }
  }
  return out;
}

// uac.reg_dump -> { "user@host:port": { status, expiresIn, serverUri } }. flags: 1 disabled, 2 in progress, 4 online
function parseUacReg(res, now = Math.floor(Date.now() / 1000)) {
  const out = {};
  for (const r of Array.isArray(res) ? res : []) {
    const f = +r.flags || 0;
    out[`${r.r_username}@${r.auth_proxy}`] = {
      serverUri: r.auth_proxy || '', status: f & 4 ? 'Registered' : f & 1 ? 'Disabled' : 'Unregistered',
      expiresIn: f & 4 && +r.timer_expires ? +r.timer_expires - now : null,
    };
  }
  return out;
}

// ul.dump -> { code: [{ uri, ip, port, userAgent, expiresAt }] } (contacts customers registered with us)
function parseUsrloc(res, now = Date.now()) {
  const out = {};
  for (const dom of (res && res.Domains) || []) {
    for (const a of (dom.Domain && dom.Domain.AoRs) || []) {
      const m = /^p_([a-z0-9_]+)$/.exec((a.Info && a.Info.AoR) || '');
      if (!m) continue;
      for (const c of a.Info.Contacts || []) {
        const k = c.Contact || {};
        const at = hostPort(k.Received && k.Received !== '[not set]' ? k.Received : k.Address);
        (out[m[1]] = out[m[1]] || []).push({ uri: k.Address || '', ip: at.ip, port: at.port,
          userAgent: k['User-Agent'] && k['User-Agent'] !== 'n/a' ? k['User-Agent'] : '', expiresAt: +k.Expires > 0 ? now + +k.Expires * 1000 : null });
      }
    }
  }
  return out;
}

// r_username of the uacreg row: the user part of an IMS username user@domain (see renderUacreg)
const regKey = (t) => `${String(t.username || '').trim().replace(/@[A-Za-z0-9.-]+$/, '')}@sip:${t.host}:${+t.port || 5060}${t.transport === 'tcp' ? ';transport=tcp' : ''}`;
const safe = (p) => p.catch(() => null);

// trunks: [{ name, host, port, transport, username, register }] -> { name: { endpoint, reg } } for the live monitor
async function trunkState(trunks) {
  const [ds, reg] = await Promise.all([safe(rpc('dispatcher.list')), safe(rpc('uac.reg_dump'))]);
  const pings = new Map(parseDispatcher(ds).map((d) => [d.duid, d]));
  const regs = parseUacReg(reg);
  const st = {};
  for (const t of trunks) {
    const d = pings.get(`t_${t.name}`);
    st[t.name] = { endpoint: !ds ? 'unknown' : !d || !d.checked ? 'unknown' : d.up ? 'online' : 'offline',
      reg: reg ? ((regs[regKey(t)] || {}).status || 'Unregistered') : 'unknown' };
  }
  return st;
}

// outbound registrations keyed by trunk name, like reg.parseRegistrations()
async function registrations(trunks) {
  const regs = parseUacReg(await safe(rpc('uac.reg_dump')));
  const out = {};
  for (const t of trunks) if (regs[regKey(t)]) out[t.name] = regs[regKey(t)];
  return out;
}
const registrar = async () => parseUsrloc(await safe(rpc('ul.dump')));
// OPTIONS ping result per fixed IP of IP-auth processes, like reg.parseMonContacts()
async function reachable() {
  const out = {};
  for (const d of parseDispatcher(await safe(rpc('dispatcher.list')))) {
    const m = /^p_([a-z0-9_]+)_([0-9.]+)$/.exec(d.duid);
    if (!m || !d.checked) continue;
    (out[m[1]] = out[m[1]] || []).push({ ip: m[2], port: hostPort(d.uri).port, status: d.up ? 'Avail' : 'Unavail', rtt: d.rtt });
  }
  return out;
}

module.exports = { trunkState, registrations, registrar, reachable, parseDispatcher, parseUacReg, parseUsrloc, regKey };
