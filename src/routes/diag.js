'use strict';
// Diagnostics: issue tracker, live SIP trace (sngrep-like), pcap download (tcpdump), RTP analysis, Asterisk log search.
const router = require('express').Router();
const fs = require('fs/promises');
const cfg = require('../config');
const ari = require('../ari');
const { audit } = require('../db');
const cap = require('../diag/capture');
const issues = require('../diag/issues');
const { Bad, wrap, str, int } = require('./util');

router.get('/status', wrap(async (req, res) => {
  res.json({ tools: cap.tools(), trace: cap.trace.status(), rtpRange: cfg.rtp, sipPort: cfg.sipPort, log: cfg.asterisk.log });
}));

// ------------------------------------------------------------------ issues
router.get('/issues', wrap(async (req, res) => res.json(await issues.list(int(req.query.limit, { min: 10, max: 1000, def: 200 })))));
router.post('/issues/run', wrap(async (req, res) => { await issues.run(); res.json(await issues.list()); }));

// ------------------------------------------------------------------ SIP trace
router.post('/sip/start', wrap(async (req, res) => {
  const o = { minutes: int(req.body.minutes, { min: 1, max: 60, def: 10 }), host: str(req.body.host, 43), keepNoise: !!req.body.keepNoise };
  const st = cap.trace.start(o);
  await audit(req.user, 'sip_trace', 'diag', null, o);
  res.json(st);
}));
router.post('/sip/stop', (req, res) => res.json(cap.trace.stop()));
router.post('/sip/clear', (req, res) => res.json(cap.trace.clear()));
router.get('/sip/dialogs', (req, res) => {
  const method = /^[A-Z]{3,10}$/.test(req.query.method || '') ? req.query.method : '';
  res.json({ status: cap.trace.status(), dialogs: cap.trace.store.list({ q: str(req.query.q, 64), method, limit: 500 }) });
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
  const o = { seconds: int(req.query.seconds, { min: 1, max: 300, def: 30 }), host: str(req.query.host, 43), port: str(req.query.port, 5),
    sip: req.query.sip !== '0', rtp: req.query.rtp === '1' };
  if (!o.sip && !o.rtp && !o.port) throw new Bad('choose SIP, RTP or a port');
  await audit(req.user, 'pcap', 'diag', null, o);
  await cap.download(res, o);
}));

// ------------------------------------------------------------------ RTP
router.post('/rtp/capture', wrap(async (req, res) => {
  res.json(await cap.rtpCapture({ seconds: int(req.body.seconds, { min: 2, max: 60, def: 10 }), host: str(req.body.host, 43) }));
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
  const maxBytes = 8 * 1024 * 1024;
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
