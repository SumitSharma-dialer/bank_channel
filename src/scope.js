'use strict';
// What a monitor-only user (role 'viewer', a team leader) may see: only GET requests behind the tabs set on the Users
// page, and only the data of their processes. Admins pass through unchanged.
const ALWAYS = new Set(['GET /reports/dispositions', 'POST /me/password']);
const BY_TAB = {
  live: ['GET /live'],
  cdr: ['GET /reports/calls', 'GET /reports/calls.csv'],
  stats: ['GET /reports/daily', 'GET /reports/usage'],
};

const isViewer = (a) => !!a && a.role === 'viewer';

// mounted on /api after requireAuth: req.path is relative to /api
function guard(req, res, next) {
  const a = req.auth;
  if (!isViewer(a)) return next();
  const key = `${req.method} ${req.path.replace(/\/+$/, '')}`;
  if (ALWAYS.has(key) || a.tabs.some((t) => (BY_TAB[t] || []).includes(key))) return next();
  res.status(403).json({ error: 'your user has monitor-only access to other pages' });
}

// live snapshot cut down to the viewer's processes; trunk-wide numbers are not shown
function snapshot(s, a) {
  if (!isViewer(a) || !s) return s;
  const mine = new Set(a.processes);
  const processes = s.processes.filter((p) => mine.has(p.code));
  const sum = (k, l = processes) => l.reduce((n, p) => n + (p[k] || 0), 0);
  return {
    at: s.at, ariConnected: s.ariConnected, viewer: true,
    live: sum('live'), processCapacity: sum('limit', processes.filter((p) => p.active)), trunkCapacity: 0,
    peakToday: sum('peak'), hitsMin: sum('hitsMin'), hitsToday: sum('hitsToday'),
    processes: processes.map((p) => ({ ...p, trunk: '' })), trunks: [],
  };
}

// hit / call events: only for the viewer's processes
const seesProcess = (a, code) => !isViewer(a) || a.processes.includes(code);

module.exports = { guard, snapshot, seesProcess, isViewer, BY_TAB };
