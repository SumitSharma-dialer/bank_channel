'use strict';
// Users and login sessions. The cookie holds a random token; the sessions table keeps its sha256, so a session can be
// listed and revoked from the Users page. Roles: 'superadmin' (everything, incl. the Activity log), 'admin' (everything
// except the Activity log; cannot touch super admins) and 'viewer' (monitor-only team leader: read-only, only the
// processes and tabs set on the Users page). Enforced here and in the routes, not only in the UI.
const crypto = require('crypto');
const cfg = require('./config');
const { q } = require('./db');

const COOKIE = 'sd_session';
const TTL = 12 * 3600 * 1000;          // session lifetime from sign-in
const TOUCH_MS = 60 * 1000;            // last_seen is written at most once a minute per session
const CACHE_MS = 30 * 1000;            // re-read user + session from the DB at least every 30 s
const VIEWER_TABS = ['live', 'cdr', 'stats'];
const ROLES = ['superadmin', 'admin', 'viewer'];

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, salt, hex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(h, Buffer.from(hex, 'hex'));
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
function cookieValue(header) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(header || '');
  return m ? decodeURIComponent(m[1]) : null;
}
const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

// token hash -> { at, auth } ; auth = { sid, user, role, processes, tabs } or null
const cache = new Map();
const touched = new Map();   // sid -> last time last_seen was written
const forget = (hash) => { if (hash) cache.delete(hash); else cache.clear(); };

async function lookup(tok) {
  if (!tok || !/^[A-Za-z0-9_-]{30,100}$/.test(tok)) return null;
  const hash = sha(tok);
  const c = cache.get(hash);
  if (c && Date.now() - c.at < CACHE_MS && (!c.auth || c.auth.exp > Date.now())) return c.auth;
  const row = (await q(`SELECT s.id, s.expires_at, a.username, a.role, a.processes, a.tabs FROM sessions s JOIN admins a ON a.username = s.username
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.active`, [hash])).rows[0];
  const auth = row ? { sid: +row.id, user: row.username, role: ROLES.includes(row.role) ? row.role : 'admin', exp: +row.expires_at,
    processes: row.processes || [], tabs: (row.tabs || []).filter((t) => VIEWER_TABS.includes(t)) } : null;
  cache.set(hash, { at: Date.now(), auth });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return auth;
}
const authFromReq = (req) => lookup(cookieValue(req.headers.cookie));

async function requireAuth(req, res, next) {
  try {
    const a = await authFromReq(req);
    if (!a) return res.status(401).json({ error: 'login required' });
    req.user = a.user; req.auth = a;
    if (Date.now() - (touched.get(a.sid) || 0) > TOUCH_MS) {
      touched.set(a.sid, Date.now());
      q('UPDATE sessions SET last_seen=now(), ip=$2 WHERE id=$1', [a.sid, clientIp(req)]).catch(() => {});
    }
    next();
  } catch (e) { next(e); }
}
const isAdmin = (a) => !!a && (a.role === 'admin' || a.role === 'superadmin');
const isSuper = (a) => !!a && a.role === 'superadmin';
function requireAdmin(req, res, next) {
  if (isAdmin(req.auth)) return next();
  res.status(403).json({ error: 'admin only' });
}
function requireSuper(req, res, next) {
  if (isSuper(req.auth)) return next();
  res.status(403).json({ error: 'super admin only' });
}

async function startSession(req, res, user) {
  const tok = crypto.randomBytes(32).toString('base64url');
  const r = await q('INSERT INTO sessions(token_hash, username, ip, user_agent, expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id',
    [sha(tok), user, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300), new Date(Date.now() + TTL)]);
  res.setHeader('Set-Cookie', `${COOKIE}=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}`);
  return +r.rows[0].id;
}
async function endSession(req, res) {
  const tok = cookieValue(req.headers.cookie);
  if (tok) {
    const r = await q(`UPDATE sessions SET revoked_at=now(), revoked_by=username WHERE token_hash=$1 AND revoked_at IS NULL RETURNING id`, [sha(tok)]);
    forget(sha(tok));
    if (r.rows[0]) bus.emit('revoked', [+r.rows[0].id]);
  }
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// Revoke sessions by id or by user (except one session, e.g. the admin's own; skipRole: leave users of that role
// alone). Emits the ids so live WebSockets close, and the ended sessions so the activity log notes each sign-out
// (reason: why, e.g. 'user disabled'; by: who did it).
const bus = new (require('events'))();
async function revoke({ ids, user, except, skipRole, by, reason }) {
  const args = [by || null], where = ['revoked_at IS NULL', 'expires_at > now()'];
  if (ids) { args.push(ids); where.push(`id = ANY($${args.length}::bigint[])`); }
  if (user) { args.push(user); where.push(`username = $${args.length}`); }
  if (except) { args.push(except); where.push(`id <> $${args.length}`); }
  if (skipRole) { args.push(skipRole); where.push(`username NOT IN (SELECT username FROM admins WHERE role = $${args.length})`); }
  const r = await q(`UPDATE sessions SET revoked_at=now(), revoked_by=$1 WHERE ${where.join(' AND ')} RETURNING id, username, ip, (SELECT role FROM admins a WHERE a.username = sessions.username) AS role`, args);
  forget();
  const out = r.rows.map((x) => +x.id);
  if (out.length) bus.emit('revoked', out, reason, r.rows.map((x) => ({ sid: +x.id, user: x.username, role: x.role, ip: x.ip, by })));
  return out;
}

async function ensureAdmin() {
  const { rows } = await q('SELECT count(*)::int AS n FROM admins');
  if (rows[0].n > 0) return;
  const pw = cfg.adminPassword || crypto.randomBytes(9).toString('base64url');
  await q(`INSERT INTO admins(username,pass_hash,role) VALUES($1,$2,'superadmin')`, ['admin', hashPassword(pw)]);
  console.log(`[auth] created super admin user: admin / ${pw}`);
}

module.exports = { hashPassword, verifyPassword, requireAuth, requireAdmin, requireSuper, isAdmin, isSuper, authFromReq, startSession, endSession, revoke, forget, bus,
  clientIp, ensureAdmin, VIEWER_TABS, ROLES, TTL };
