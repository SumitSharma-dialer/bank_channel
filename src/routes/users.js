'use strict';
// Users page (admins only): users with role superadmin / admin / viewer (monitor-only team leader with chosen processes
// and tabs) and the login sessions of all users. Only a super admin can create, change, sign out or delete a super admin
// or give that role; plain admins see super admins read-only.
const router = require('express').Router();
const { q, audit } = require('../db');
const auth = require('../auth');
const { Bad, wrap, str, bool, diff } = require('./util');

const USER_RE = /^[a-zA-Z0-9._-]{3,64}$/;
const pub = (r) => ({ id: r.id, username: r.username, full_name: r.full_name || '', role: r.role, processes: r.processes || [], tabs: r.tabs || [],
  active: r.active, created_at: r.created_at, last_login: r.last_login, sessions: r.sessions || 0 });

async function body(b, isNew) {
  const out = {};
  if (isNew) {
    out.username = str(b.username, 64);
    if (!USER_RE.test(out.username)) throw new Bad('username: 3–64 characters, letters, digits, . _ -');
  }
  out.full_name = str(b.full_name, 100) || null;
  out.role = auth.ROLES.includes(b.role) ? b.role : 'viewer';
  if (out.role === 'viewer') {
    const codes = [...new Set((Array.isArray(b.processes) ? b.processes : []).map((c) => str(c, 32)).filter(Boolean))];
    const known = new Set((await q('SELECT code FROM processes WHERE code = ANY($1)', [codes])).rows.map((r) => r.code));
    for (const c of codes) if (!known.has(c)) throw new Bad(`unknown process ${c}`);
    const tabs = [...new Set((Array.isArray(b.tabs) ? b.tabs : []).filter((t) => auth.VIEWER_TABS.includes(t)))];
    if (!codes.length) throw new Bad('pick at least one process for a monitor user');
    if (!tabs.length) throw new Bad('pick at least one tab for a monitor user');
    out.processes = codes; out.tabs = tabs;
  } else { out.processes = []; out.tabs = []; }
  return out;
}
const password = (v) => {
  const p = str(v, 200);
  if (p.length < 8) throw new Bad('password must be at least 8 characters');
  return p;
};
// at least one active super admin must stay
async function keepASuper(exceptId) {
  const n = (await q(`SELECT count(*)::int AS n FROM admins WHERE role='superadmin' AND active AND id <> $1`, [exceptId])).rows[0].n;
  if (!n) throw new Bad('this is the last active super admin — add or enable another super admin first');
}
const forbid = (msg) => Object.assign(new Error(msg), { status: 403 });
// a plain admin may not touch super admins nor hand out that role
function mayManage(req, u, newRole) {
  if (auth.isSuper(req.auth)) return;
  if (u && u.role === 'superadmin') throw forbid('only a super admin can change a super admin');
  if (newRole === 'superadmin') throw forbid('only a super admin can give the super admin role');
}
const byId = async (id) => {
  const u = (await q('SELECT * FROM admins WHERE id=$1', [+id || 0])).rows[0];
  if (!u) throw Object.assign(new Error('user not found'), { status: 404 });
  return u;
};

router.get('/', wrap(async (req, res) => {
  const { rows } = await q(`SELECT a.*, (SELECT count(*)::int FROM sessions s WHERE s.username=a.username AND s.revoked_at IS NULL AND s.expires_at > now()) AS sessions
    FROM admins a ORDER BY array_position(ARRAY['superadmin','admin','viewer']::text[], a.role::text), a.username`);
  const procs = (await q('SELECT code, name, active FROM processes ORDER BY code')).rows;
  res.json({ users: rows.map(pub), processes: procs, tabs: auth.VIEWER_TABS, me: req.user, super: auth.isSuper(req.auth) });
}));

router.post('/', wrap(async (req, res) => {
  const b = await body(req.body, true);
  mayManage(req, null, b.role);
  const pw = password(req.body.password);
  const { rows } = await q(`INSERT INTO admins(username, pass_hash, full_name, role, processes, tabs) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [b.username, auth.hashPassword(pw), b.full_name, b.role, b.processes, b.tabs]).catch((e) => {
    if (e.code === '23505') throw new Bad(`user ${b.username} already exists`);
    throw e;
  });
  await audit(req.user, 'user_create', 'admin', rows[0].id, { username: b.username, role: b.role, processes: b.processes, tabs: b.tabs });
  res.json(pub(rows[0]));
}));

router.put('/:id', wrap(async (req, res) => {
  const u = await byId(req.params.id);
  const b = await body(req.body, false);
  mayManage(req, u, b.role);
  const active = req.body.active === undefined ? u.active : bool(req.body.active);
  if (u.username === req.user && (!active || b.role !== u.role)) throw new Bad('you cannot disable yourself or change your own role');
  if (u.role === 'superadmin' && u.active && (b.role !== 'superadmin' || !active)) await keepASuper(u.id);
  const changes = diff(u, { ...b, active });
  const { rows } = await q(`UPDATE admins SET full_name=$2, role=$3, processes=$4, tabs=$5, active=$6 WHERE id=$1 RETURNING *`,
    [u.id, b.full_name, b.role, b.processes, b.tabs, active]);
  auth.forget();   // new rights apply on the next request
  let ended = [];
  if (!active || u.role !== b.role) ended = await auth.revoke({ user: u.username, by: req.user });   // disabled / role changed: sign out
  await audit(req.user, 'user_update', 'admin', u.id, { username: u.username, changes, sessionsEnded: ended.length });
  res.json(pub(rows[0]));
}));

router.post('/:id/password', wrap(async (req, res) => {
  const u = await byId(req.params.id);
  mayManage(req, u);
  const pw = password(req.body.password);
  await q('UPDATE admins SET pass_hash=$2 WHERE id=$1', [u.id, auth.hashPassword(pw)]);
  const ended = await auth.revoke({ user: u.username, except: u.username === req.user ? req.auth.sid : null, by: req.user });
  await audit(req.user, 'user_password', 'admin', u.id, { username: u.username, sessionsEnded: ended.length });
  res.json({ ok: true, sessionsEnded: ended.length });
}));

router.delete('/:id', wrap(async (req, res) => {
  const u = await byId(req.params.id);
  if (u.username === req.user) throw new Bad('you cannot delete yourself');
  mayManage(req, u);
  if (u.role === 'superadmin' && u.active) await keepASuper(u.id);
  await auth.revoke({ user: u.username, by: req.user });
  await q('DELETE FROM admins WHERE id=$1', [u.id]);
  await audit(req.user, 'user_delete', 'admin', u.id, { username: u.username });
  res.json({ ok: true });
}));

// ---- sessions of all users
router.get('/sessions', wrap(async (req, res) => {
  const all = req.query.all === '1';
  const { rows } = await q(`SELECT s.id, s.username, s.ip, s.user_agent, s.created_at, s.last_seen, s.expires_at, s.revoked_at, s.revoked_by,
      a.role, a.full_name, (s.revoked_at IS NULL AND s.expires_at > now()) AS open
    FROM sessions s LEFT JOIN admins a ON a.username = s.username
    ${all ? '' : 'WHERE s.revoked_at IS NULL AND s.expires_at > now()'}
    ORDER BY open DESC, s.last_seen DESC LIMIT 300`);
  res.json({ sessions: rows.map((r) => ({ ...r, id: +r.id, current: +r.id === req.auth.sid })), ttlHours: auth.TTL / 3600e3 });
}));

router.delete('/sessions/:sid', wrap(async (req, res) => {
  const sid = +req.params.sid || 0;
  if (sid === req.auth.sid) throw new Bad('this is your own session — use Sign out');
  const owner = (await q('SELECT a.role FROM sessions s JOIN admins a ON a.username = s.username WHERE s.id=$1', [sid])).rows[0];
  mayManage(req, owner);
  const ended = await auth.revoke({ ids: [sid], by: req.user });
  if (!ended.length) throw new Bad('session already ended');
  await audit(req.user, 'session_end', 'session', sid, null);
  res.json({ ok: true });
}));

// sign a user out everywhere (or with user = '' every other session of every user; a plain admin leaves super admins)
router.post('/sessions/end', wrap(async (req, res) => {
  const user = str(req.body.user, 64);
  if (user) mayManage(req, (await q('SELECT role FROM admins WHERE username=$1', [user])).rows[0]);
  const ended = await auth.revoke({ user: user || undefined, except: req.auth.sid, by: req.user,
    skipRole: auth.isSuper(req.auth) ? undefined : 'superadmin' });
  await audit(req.user, 'session_end_all', 'session', null, { user: user || '(all users)', ended: ended.length });
  res.json({ ok: true, ended: ended.length });
}));

module.exports = router;
