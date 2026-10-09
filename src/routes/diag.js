'use strict';
// Diagnostics: issue tracker, live SIP trace (sngrep-like), pcap download (tcpdump), RTP analysis, Asterisk log search.
const router = require('express').Router();
const fs = require('fs/promises');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const cfg = require('../config');
const ari = require('../ari');
const { q, audit } = require('../db');
const cap = require('../diag/capture');
const issues = require('../diag/issues');
const { Bad, wrap, str, int } = require('./util');

// Capture target -> IPs. target: '' (all) | 'ip' (+ host) | 'trunk:<name>' | 'process:<code>'
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|[0-9a-fA-F:]{2,39})$/;
const contactIps = (endpoint) => new Promise((resolve) => {
  execFile('asterisk', ['-rx', 'pjsip show contacts'], { timeout: 4000 }, (err, out) => {
    const ips = new Set();
    // "Contact:  p_acme/sip:acme@203.0.113.5:5060;ob   a1b2c3 Avail  12.3"
    for (const m of String(out || '').matchAll(new RegExp(`${endpoint}/sips?:(?:[^@\\s;]*@)?\\[?([0-9a-fA-F.:]+?)\\]?(?::\\d+)?[;\\s]`, 'g'))) ips.add(m[1]);
    resolve([...ips]);
  });
});
async function target(src) {
  const t = str(src.target, 40), host = str(src.host, 43);
  if (!t) return { hosts: [], name: '' };
  if (t === 'ip') {
    if (!IP_RE.test(host)) throw new Bad('enter an IP address or CIDR, e.g. 203.0.113.5 or 203.0.113.0/24');
    return { hosts: [host], name: host.replace(/[/:]/g, '_') };
  }
  const [kind, ref] = t.split(':');
  if (kind === 'trunk') {
    const tr = (await q('SELECT name, host FROM trunks WHERE name=$1', [ref])).rows[0];
    if (!tr) throw new Bad('unknown trunk');
    let hosts = IP_RE.test(tr.host) ? [tr.host] : [];
    if (!hosts.length) {
      try { hosts = (await dns.lookup(tr.host, { all: true })).map((a) => a.address); }
      catch (e) { throw new Bad(`cannot resolve trunk host ${tr.host}: ${e.code || e.message}`); }
    }
    return { hosts, name: `trunk_${tr.name}` };
  }
  if (kind === 'process') {
    const p = (await q('SELECT code, auth_type, allowed_ips FROM processes WHERE code=$1', [ref])).rows[0];
    if (!p) throw new Bad('unknown process');
    let hosts = p.auth_type === 'ip' ? String(p.allowed_ips || '').split(/[\s,]+/).filter((x) => IP_RE.test(x)) : [];
    if (!hosts.length) hosts = await contactIps(`p_${p.code}`);   // password auth: where it registered from
    if (!hosts.length) throw new Bad(`process ${p.code} has no allowed IP and is not registered — use "Custom IP"`);
    return { hosts, name: `proc_${p.code}` };
  }
  throw new Bad('unknown capture target');
}

// resolve a target without capturing (the UI shows which IPs will be captured)
router.get('/target', wrap(async (req, res) => res.json(await target(req.query))));

router.get('/status', wrap(async (req, res) => {
  res.json({ tools: cap.tools(), trace: cap.trace.status(), rtpRange: cfg.rtp, sipPort: cfg.sipPort, log: cfg.asterisk.log });
}));

// ------------------------------------------------------------------ issues
router.get('/issues', wrap(async (req, res) => res.json(await issues.list(int(req.query.limit, { min: 10, max: 1000, def: 200 })))));
router.post('/issues/run', wrap(async (req, res) => { await issues.run(); res.json(await issues.list()); }));

// ------------------------------------------------------------------ alerts (Slack / Gmail)
const alerts = require('../diag/alerts');
router.get('/alerts', wrap(async (req, res) => res.json({ ...(await alerts.status()), recent: await alerts.recent() })));
router.put('/alerts', wrap(async (req, res) => {
  const st = await alerts.save(req.body || {});
  // never log secrets: only which sections changed
  await audit(req.user, 'alert_settings', 'diag', null, { sections: Object.keys(req.body || {}).filter((k) => k !== 'clear'), clear: req.body.clear });
  res.json({ ...st, recent: await alerts.recent() });
}));
router.post('/alerts/test', wrap(async (req, res) => {
  await alerts.test(String(req.body.channel || ''));
  await audit(req.user, 'alert_test', 'diag', null, { channel: req.body.channel });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ registrations
router.get('/registrations', wrap(async (req, res) => res.json(await require('../diag/reg').collect(cap.trace.log))));

// ------------------------------------------------------------------ SIP trace
router.post('/sip/start', wrap(async (req, res) => {
  const tg = await target(req.body);
  const o = { minutes: int(req.body.minutes, { min: 1, max: 60, def: 10 }), hosts: tg.hosts, label: tg.name, keepNoise: !!req.body.keepNoise };
  const st = cap.trace.start(o);
  await audit(req.user, 'sip_trace', 'diag', null, { ...o, target: req.body.target || 'all' });
  res.json(st);
}));
router.post('/sip/stop', (req, res) => res.json(cap.trace.stop()));
router.post('/sip/clear', (req, res) => res.json(cap.trace.clear()));
router.get('/sip/dialogs', (req, res) => {
  const method = /^[A-Z]{3,10}$/.test(req.query.method || '') ? req.query.method : '';
  res.json({ status: cap.trace.status(), dialogs: cap.trace.store.list({ q: str(req.query.q, 64), method, limit: 500 }) });
});
// live message stream: poll with ?after=<last id>; types=call,register,options,other
router.get('/sip/messages', (req, res) => {
  const types = new Set(String(req.query.types || '').split(',').filter((t) => ['call', 'register', 'options', 'other'].includes(t)));
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  const hidden = {};
  const messages = cap.trace.log.since(after, { types, q: str(req.query.q, 64), limit: after ? 500 : 300, hidden });
  res.json({ status: cap.trace.status(), messages, hidden });
});
router.get('/sip/dialog', (req, res) => {
  const g = cap.trace.store.get(String(req.query.id || ''));
  if (!g) return res.status(404).json({ error: 'dialog not in the trace buffer' });
  const { records, ...rest } = g;
  res.json(rest);
});
router.get('/sip/dialog.pcap', (req, res) => {
  const buf = cap.trace.pcap(String(req.query.id || ''));
  if (!buf) return res.status(404).json({ error: 'dialog not in the trace buffer' });
  res.setHeader('Content-Type', 'application/vnd.tcpdump.pcap');
  res.setHeader('Content-Disposition', `attachment; filename="call_${String(req.query.id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60)}.pcap"`);
  res.end(buf);
});

// ------------------------------------------------------------------ tcpdump download
router.get('/pcap', wrap(async (req, res) => {
  const tg = await target(req.query);
  const o = { seconds: int(req.query.seconds, { min: 1, max: 300, def: 30 }), hosts: tg.hosts, name: tg.name, port: str(req.query.port, 5),
    sip: req.query.sip !== '0', rtp: req.query.rtp === '1', tool: req.query.tool === 'sngrep' ? 'sngrep' : 'tcpdump', match: str(req.query.match, 64) };
  if (!o.sip && !o.rtp && !o.port) throw new Bad('choose SIP, RTP or a port');
  await audit(req.user, 'pcap', 'diag', null, o);
  await cap.download(res, o);
}));

// ------------------------------------------------------------------ RTP
router.post('/rtp/capture', wrap(async (req, res) => {
  const tg = await target(req.body);
  res.json(await cap.rtpCapture({ seconds: int(req.body.seconds, { min: 2, max: 60, def: 10 }), hosts: tg.hosts }));
}));

// Asterisk's own RTP counters for every live channel (ARI GET /channels/{id}/rtp_statistics)
router.get('/rtp/channels', wrap(async (req, res) => {
  if (!ari.connected) throw new Bad('ARI is not connected');
  const chans = (await ari.channels()).filter((c) => /^PJSIP\//.test(c.name)).slice(0, 300);
  const out = [];
  for (let i = 0; i < chans.length; i += 25) {
    const part = await Promise.all(chans.slice(i, i + 25).map(async (c) => {
      let s = null;
      try { s = await ari.get(`/channels/${encodeURIComponent(c.id)}/rtp_statistics`); } catch { /* no RTP yet */ }
      const age = (Date.now() - new Date(c.creationtime).getTime()) / 1000;
      const problems = [];
      if (s) {
        if (c.state === 'Up' && age > 5 && !s.rxcount) problems.push('no RTP received (no / one-way audio)');
        if (c.state === 'Up' && age > 5 && !s.txcount) problems.push('no RTP sent');
        if (s.rxcount > 50 && s.rxploss / (s.rxcount + s.rxploss) >= 0.01) problems.push(`rx loss ${(100 * s.rxploss / (s.rxcount + s.rxploss)).toFixed(1)}%`);
        if (s.rxjitter >= 0.03) problems.push(`rx jitter ${Math.round(s.rxjitter * 1000)} ms`);
        if (s.rtt >= 0.3) problems.push(`RTT ${Math.round(s.rtt * 1000)} ms`);
      }
      return { id: c.id, name: c.name, state: c.state, caller: c.caller && c.caller.number, connected: c.connected && c.connected.number,
        exten: c.dialplan && c.dialplan.exten, age: Math.round(age), stats: s && {
          rxcount: s.rxcount, txcount: s.txcount, rxploss: s.rxploss, txploss: s.txploss,
          // rxjitter is measured locally in seconds; txjitter is what the far end reports in RTCP (unit varies by version)
          rxjitterMs: +(1000 * (s.rxjitter || 0)).toFixed(1), txjitter: s.txjitter,
          rttMs: +(1000 * (s.rtt || 0)).toFixed(1), localSsrc: s.local_ssrc, remoteSsrc: s.remote_ssrc }, problems };
    }));
    out.push(...part);
  }
  res.json(out);
}));

// ------------------------------------------------------------------ Asterisk log
const LEVEL_RE = /^\[[^\]]+\]\s+(ERROR|WARNING|NOTICE|VERBOSE|DEBUG|SECURITY|DTMF)\[/;
router.get('/log', wrap(async (req, res) => {
  const needle = str(req.query.q, 100).toLowerCase();
  const levels = String(req.query.levels || 'ERROR,WARNING,NOTICE').split(',').filter((l) => /^[A-Z]+$/.test(l));
  const lines = int(req.query.lines, { min: 50, max: 2000, def: 500 });
  const maxBytes = 32 * 1024 * 1024;   // the full log has verbose lines too
  let fh;
  try { fh = await fs.open(cfg.asterisk.log, 'r'); } catch (e) { throw new Bad(`cannot read ${cfg.asterisk.log}: ${e.code || e.message}`); }
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const all = buf.toString('utf8').split('\n');
    if (len < size) all.shift();   // partial first line
    const out = [];
    for (let i = all.length - 1; i >= 0 && out.length < lines; i--) {
      const l = all[i]; if (!l) continue;
      const m = LEVEL_RE.exec(l);
      if (m && !levels.includes(m[1])) continue;
      if (needle && !l.toLowerCase().includes(needle)) continue;
      out.push(l.length > 2000 ? l.slice(0, 2000) + '…' : l);
    }
    res.json({ file: cfg.asterisk.log, scannedBytes: len, size, lines: out.reverse() });
  } finally { await fh.close(); }
}));

module.exports = router;
