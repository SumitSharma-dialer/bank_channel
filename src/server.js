'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const cfg = require('./config');
const { q, audit } = require('./db');
const auth = require('./auth');
const scope = require('./scope');
const activity = require('./activity');
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
  const u = str(req.body.username, 64), p = str(req.body.password, 200);
  if (a.n >= 10) {
    activity.event(req, { user: u, status: 429, action: 'Sign-in blocked (too many attempts)' });
    return res.status(429).json({ error: 'too many attempts, wait 15 minutes' });
  }
  const row = (await q('SELECT * FROM admins WHERE username=$1', [u])).rows[0];
  if (!row || !auth.verifyPassword(p, row.pass_hash)) {
    a.n++; attempts.set(ip, a);
    activity.event(req, { user: u, role: row && row.role, status: 401, action: row ? 'Sign-in failed (wrong password)' : 'Sign-in failed (unknown user)' });
    return res.status(401).json({ error: 'wrong username or password' });
  }
  if (!row.active) {
    activity.event(req, { user: u, role: row.role, status: 403, action: 'Sign-in refused (user disabled)' });
    return res.status(403).json({ error: 'this user is disabled — ask an admin' });
  }
  attempts.delete(ip);
  const sid = await auth.startSession(req, res, u);
  activity.event(req, { user: u, role: row.role, sid, status: 200, action: 'Signed in' });
  await q('UPDATE admins SET last_login=now() WHERE id=$1', [row.id]);
  await audit(u, 'login', 'admin', row.id, { ip: auth.clientIp(req) });
  res.json({ user: u });
}));
app.post('/api/logout', wrap(async (req, res) => {
  const a = await auth.authFromReq(req);
  await auth.endSession(req, res);
  if (a) {
    await audit(a.user, 'logout', 'admin', null, null);
    activity.event(req, { user: a.user, role: a.role, sid: a.sid, status: 200, action: 'Signed out' });
  }
  res.json({ ok: true });
}));
app.get('/api/me', wrap(async (req, res) => {
  const a = await auth.authFromReq(req);
  if (!a) return res.status(401).json({ error: 'login required' });
  const me = { user: a.user, role: a.role, publicIp: cfg.publicIp, sipPort: cfg.sipPort, tz: cfg.statsTz };
  if (a.role === 'viewer') {
    Object.assign(me, { tabs: a.tabs, publicIp: undefined, sipPort: undefined,
      processes: (await q('SELECT code, name FROM processes WHERE code = ANY($1) ORDER BY code', [a.processes])).rows });
  }
  res.json(me);
}));

// ---- protected API
app.use('/internal', require('./routes/internal'));   // Asterisk on localhost (dialplan CURL)
app.use('/api', auth.requireAuth);
app.use('/api', activity.middleware);   // activity log (Activity page, super admins)
app.use('/api', scope.guard);   // monitor-only users: only their tabs, read-only
app.use('/api/me', require('./routes/me'));
app.use('/api/users', auth.requireAdmin, require('./routes/users'));
app.use('/api/activity', auth.requireSuper, require('./routes/activity'));
app.use('/api/trunks', auth.requireAdmin, require('./routes/trunks'));
app.use('/api/processes', auth.requireAdmin, require('./routes/processes'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/system', auth.requireAdmin, require('./routes/system'));
app.use('/api/dispositions', auth.requireAdmin, require('./routes/dispositions'));
app.use('/api/diag', auth.requireAdmin, require('./routes/diag'));
app.get('/api/live', wrap(async (req, res) => res.json(scope.snapshot(await tracker.snapshot(), req.auth))));

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
server.on('upgrade', async (req, sock, head) => {
  const a = req.url.startsWith('/ws') ? await auth.authFromReq(req).catch(() => null) : null;
  if (!a || (a.role === 'viewer' && !a.tabs.includes('live'))) { sock.destroy(); return; }
  activity.event(req, { user: a.user, role: a.role, sid: a.sid, status: 101, action: 'Connected live feed' });
  wss.handleUpgrade(req, sock, head, (ws) => { ws.auth = a; wss.emit('connection', ws); });
});
// each client gets only what its user may see (monitor-only users: their processes)
const broadcast = (type, pick) => {
  let full = null;
  for (const c of wss.clients) {
    if (c.readyState !== 1) continue;
    if (!scope.isViewer(c.auth)) { c.send(full ||= JSON.stringify({ type, data: pick(c.auth) })); continue; }
    const data = pick(c.auth);
    if (data) c.send(JSON.stringify({ type, data }));
  }
};
wss.on('connection', async (ws) => {
  try { ws.send(JSON.stringify({ type: 'snapshot', data: scope.snapshot(await tracker.snapshot(), ws.auth) })); } catch { /* ignore */ }
});
tracker.bus.on('snapshot', (s) => {
  if (!wss.clients.size) return;
  const all = { ...s, issues: issues.summary() };
  broadcast('snapshot', (a) => (scope.isViewer(a) ? scope.snapshot(s, a) : all));
});
tracker.bus.on('hit', (h) => broadcast('hit', (a) => (scope.seesProcess(a, h.process) ? h : null)));
tracker.bus.on('call', (c) => broadcast('call', (a) => (scope.seesProcess(a, c.process) ? (scope.isViewer(a) ? { ...c, trunk: undefined } : c) : null)));
// signed out / revoked on the Users page: drop its live feed at once
auth.bus.on('revoked', (ids) => { for (const c of wss.clients) if (c.auth && ids.includes(c.auth.sid)) c.close(4401, 'session ended'); });

(async () => {
  await auth.ensureAdmin();
  tracker.start();
  issues.start();
  require('./sysinfo').startHistory();   // CPU / RAM / storage every minute, kept 5 days (System page graphs)
  require('./retention').start();   // delete DB history older than RETENTION_DAYS (5)
  apply('startup');   // make Asterisk config match the DB on every boot
  server.listen(cfg.http.port, cfg.http.host, () =>
    console.log(`[http] SIP Channel Distributor UI on http://${cfg.http.host}:${cfg.http.port}`));
})().catch((e) => { console.error('startup failed:', e); process.exit(1); });
