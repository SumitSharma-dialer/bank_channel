'use strict';
const crypto = require('crypto');
const cfg = require('./config');
const { q } = require('./db');

const COOKIE = 'sd_session';
const TTL = 12 * 3600 * 1000;

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

const sign = (data) => crypto.createHmac('sha256', cfg.sessionSecret).update(data).digest('base64url');
function makeToken(user) {
  const body = Buffer.from(JSON.stringify({ u: user, e: Date.now() + TTL })).toString('base64url');
  return `${body}.${sign(body)}`;
}
function readToken(tok) {
  if (!tok || !tok.includes('.')) return null;
  const [body, sig] = tok.split('.');
  const good = sign(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString());
    return d.e > Date.now() ? d.u : null;
  } catch { return null; }
}
function cookieValue(header) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(header || '');
  return m ? decodeURIComponent(m[1]) : null;
}
const userFromReq = (req) => readToken(cookieValue(req.headers.cookie));

function requireAuth(req, res, next) {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: 'login required' });
  req.user = u; next();
}

function setCookie(res, user) {
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken(user)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}`);
}
function clearCookie(res) { res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); }

async function ensureAdmin() {
  const { rows } = await q('SELECT count(*)::int AS n FROM admins');
  if (rows[0].n > 0) return;
  const pw = cfg.adminPassword || crypto.randomBytes(9).toString('base64url');
  await q('INSERT INTO admins(username,pass_hash) VALUES($1,$2)', ['admin', hashPassword(pw)]);
  console.log(`[auth] created admin user: admin / ${pw}`);
}

module.exports = { hashPassword, verifyPassword, requireAuth, userFromReq, setCookie, clearCookie, ensureAdmin };
