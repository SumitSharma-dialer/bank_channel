'use strict';
// Activity log: every /api request of a signed-in user (who, when, IP, what, result), plus sign-in / sign-out and
// failed sign-ins. Only super admins can read it (Activity page). Background refreshes the UI marks with X-Poll
// (timers on the System / Processes / Diagnostics pages) are not logged, and the same GET of the same session is
// logged at most once a minute, so the log shows what people did, not timer noise.
const { q } = require('./db');
const { clientIp } = require('./auth');

const DEDUP_MS = 60 * 1000;
const seen = new Map();   // `${sid} ${method} ${url}` -> last logged

// [method, path regexp (relative to /api), readable action]
const NAMES = [
  ['GET', /^\/live$/, 'Opened live dashboard'],
  ['GET', /^\/reports\/calls$/, 'Searched CDR report'],
  ['GET', /^\/reports\/calls\.csv$/, 'Exported CDR CSV'],
  ['GET', /^\/reports\/daily$/, 'Viewed daily statistics'],
  ['GET', /^\/reports\/usage$/, 'Viewed usage chart'],
  ['GET', /^\/trunks$/, 'Viewed SIP trunks'],
  ['POST', /^\/trunks$/, 'Added trunk'],
  ['PUT', /^\/trunks\/\d+$/, 'Edited trunk'],
  ['POST', /^\/trunks\/\d+\/active$/, 'Enabled / disabled trunk'],
  ['DELETE', /^\/trunks\/\d+$/, 'Deleted trunk'],
  ['GET', /^\/processes$/, 'Viewed processes'],
  ['GET', /^\/processes\/\d+\/header-log$/, 'Viewed process header log'],
  ['GET', /^\/processes\/\d+\/peer-config$/, 'Viewed process peer config'],
  ['POST', /^\/processes$/, 'Added process'],
  ['PUT', /^\/processes\/\d+$/, 'Edited process'],
  ['POST', /^\/processes\/\d+\/limit$/, 'Changed process limit'],
  ['POST', /^\/processes\/\d+\/regenerate$/, 'Regenerated process credentials'],
  ['POST', /^\/processes\/\d+\/active$/, 'Enabled / disabled process'],
  ['DELETE', /^\/processes\/\d+$/, 'Deleted process'],
  ['GET', /^\/dispositions$/, 'Viewed dispositions'],
  ['PUT', /^\/dispositions\//, 'Edited dispositions'],
  ['GET', /^\/diag\/sip\/dialog\.pcap$/, 'Downloaded SIP dialog pcap'],
  ['GET', /^\/diag\/pcap$/, 'Downloaded packet capture'],
  ['POST', /^\/diag\/sip\/start$/, 'Started SIP trace'],
  ['POST', /^\/diag\/sip\/stop$/, 'Stopped SIP trace'],
  ['POST', /^\/diag\/sip\/clear$/, 'Cleared SIP trace'],
  ['POST', /^\/diag\/rtp\/capture$/, 'Started RTP capture'],
  ['POST', /^\/diag\/issues\/run$/, 'Ran issue checks'],
  ['PUT', /^\/diag\/alerts$/, 'Changed alert settings'],
  ['POST', /^\/diag\/alerts\/test$/, 'Sent test alert'],
  ['GET', /^\/diag\//, 'Used diagnostics'],
  ['GET', /^\/users$/, 'Viewed users'],
  ['POST', /^\/users$/, 'Added user'],
  ['PUT', /^\/users\/\d+$/, 'Edited user'],
  ['POST', /^\/users\/\d+\/password$/, "Set a user's password"],
  ['DELETE', /^\/users\/\d+$/, 'Deleted user'],
  ['GET', /^\/users\/sessions$/, 'Viewed sessions'],
  ['DELETE', /^\/users\/sessions\/\d+$/, 'Signed out a session'],
  ['POST', /^\/users\/sessions\/end$/, 'Signed out sessions'],
  ['POST', /^\/me\/password$/, 'Changed own password'],
  ['GET', /^\/system\/(health|config-preview)$/, 'Opened system page'],
  ['GET', /^\/system\/resources\/history$/, 'Viewed resource history'],
  ['GET', /^\/system\/cli\//, 'Ran Asterisk CLI view'],
  ['POST', /^\/system\/apply$/, 'Re-applied Asterisk config'],
  ['GET', /^\/activity/, 'Viewed activity log'],
];
const nameOf = (method, path) => (NAMES.find(([m, re]) => m === method && re.test(path)) || [])[2] || null;

function write(r) {
  q(`INSERT INTO activity_log(username, role, sid, ip, method, path, query, status, ms, action) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [r.username || null, r.role || null, r.sid || null, r.ip || null, r.method, String(r.path).slice(0, 200), r.query || null,
      r.status || null, r.ms == null ? null : r.ms, r.action ? String(r.action).slice(0, 64) : null])
    .catch((e) => console.error('[activity]', e.message));
}

// query string without secrets (passwords never travel in the query, but be safe)
function cleanQuery(url) {
  const i = url.indexOf('?');
  if (i < 0) return null;
  const p = new URLSearchParams(url.slice(i + 1));
  for (const k of [...p.keys()]) if (/pass|secret|token/i.test(k)) p.set(k, '***');
  return p.toString().slice(0, 1000) || null;
}

// mounted on /api after requireAuth
function middleware(req, res, next) {
  const a = req.auth;
  if (!a || req.get('x-poll')) return next();
  if (req.method === 'GET') {
    const key = `${a.sid} GET ${req.url}`, now = Date.now();
    if (now - (seen.get(key) || 0) < DEDUP_MS) return next();
    seen.set(key, now);
    if (seen.size > 20000) for (const [k, t] of seen) if (now - t > DEDUP_MS) seen.delete(k);
  }
  const t0 = Date.now(), path = req.path.replace(/\/+$/, '') || '/';
  res.on('finish', () => write({ username: a.user, role: a.role, sid: a.sid, ip: clientIp(req), method: req.method,
    path: '/api' + path, query: cleanQuery(req.url), status: res.statusCode, ms: Date.now() - t0, action: nameOf(req.method, path) }));
  next();
}

// sign-in / sign-out (outside requireAuth) and live feed connects (raw http request: no req.path)
const event = (req, { user, role, sid, status, action }) =>
  write({ username: user, role, sid, ip: clientIp(req), method: req.method, path: req.path || req.url.split('?')[0], status, action });

module.exports = { middleware, event, nameOf, cleanQuery };
