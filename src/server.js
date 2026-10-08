'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const cfg = require('./config');
const { q, audit } = require('./db');
const auth = require('./auth');
const tracker = require('./tracker');
const issues = require('./diag/issues');
const { apply } = require('./asterisk/apply');
const { wrap, str } = require('./routes/util');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => { res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

// ---- auth
const attempts = new Map();
app.post('/api/login', wrap(async (req, res) => {
  const ip = req.socket.remoteAddress;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: 'too many attempts, wait 15 minutes' });
  const u = str(req.body.username, 64), p = str(req.body.password, 200);
  const row = (await q('SELECT * FROM admins WHERE username=$1', [u])).rows[0];
  if (!row || !auth.verifyPassword(p, row.pass_hash)) {
    a.n++; attempts.set(ip, a);
    return res.status(401).json({ error: 'wrong username or password' });
  }
  attempts.delete(ip);
  auth.setCookie(res, u);
  await audit(u, 'login', 'admin', row.id, { ip });
  res.json({ user: u });
}));
app.post('/api/logout', (req, res) => { auth.clearCookie(res); res.json({ ok: true }); });
app.get('/api/me', (req, res) => {
  const u = auth.userFromReq(req);
  if (!u) return res.status(401).json({ error: 'login required' });
  res.json({ user: u, publicIp: cfg.publicIp, sipPort: cfg.sipPort, tz: cfg.statsTz });
});

// ---- protected API
app.use('/internal', require('./routes/internal'));   // Asterisk on localhost (dialplan CURL)
app.use('/api', auth.requireAuth);
app.use('/api/trunks', require('./routes/trunks'));
app.use('/api/processes', require('./routes/processes'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/system', require('./routes/system'));
app.use('/api/dispositions', require('./routes/dispositions'));
app.use('/api/diag', require('./routes/diag'));
app.get('/api/live', wrap(async (req, res) => res.json(await tracker.snapshot())));

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[http]', req.method, req.url, err);
  res.status(status).json({ error: status >= 500 ? 'server error: ' + err.message : err.message });
});

// ---- UI
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));   // always revalidate (ETag) so UI updates show up at once

// ---- WebSocket live feed: /ws  (snapshot every 1 s, hit + call events instantly)
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (!req.url.startsWith('/ws') || !auth.userFromReq(req)) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws));
});
const broadcast = (type, data) => {
  const msg = JSON.stringify({ type, data });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
};
wss.on('connection', async (ws) => {
  try { ws.send(JSON.stringify({ type: 'snapshot', data: await tracker.snapshot() })); } catch { /* ignore */ }
});
tracker.bus.on('snapshot', (s) => { if (wss.clients.size) broadcast('snapshot', { ...s, issues: issues.summary() }); });
tracker.bus.on('hit', (h) => broadcast('hit', h));
tracker.bus.on('call', (c) => broadcast('call', c));

(async () => {
  await auth.ensureAdmin();
  tracker.start();
  issues.start();
  require('./retention').start();   // delete DB history older than RETENTION_DAYS (5)
  apply('startup');   // make Asterisk config match the DB on every boot
  server.listen(cfg.http.port, cfg.http.host, () =>
    console.log(`[http] SIP Channel Distributor UI on http://${cfg.http.host}:${cfg.http.port}`));
})().catch((e) => { console.error('startup failed:', e); process.exit(1); });
