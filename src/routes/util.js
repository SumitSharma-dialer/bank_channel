'use strict';
const crypto = require('crypto');

class Bad extends Error { constructor(msg) { super(msg); this.status = 400; } }

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const str = (v, max = 255) => (v == null ? '' : String(v).trim().slice(0, max));
function int(v, { min = -Infinity, max = Infinity, def } = {}) {
  if ((v === '' || v == null) && def !== undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Bad(`value ${v} must be a whole number between ${min} and ${max}`);
  return n;
}
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
function name(v, what) {
  const s = str(v, 32).toLowerCase();
  if (!/^[a-z0-9_]{2,32}$/.test(s)) throw new Bad(`${what} must be 2–32 chars: a-z, 0-9, _`);
  return s;
}
const HOST_RE = /^[a-zA-Z0-9.\-]{1,253}$/;
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const CODECS = new Set(['ulaw', 'alaw', 'g729', 'g722', 'gsm', 'opus']);
function codecs(v) {
  const list = str(v || 'ulaw,alaw').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  for (const c of list) if (!CODECS.has(c)) throw new Bad(`unknown codec ${c}`);
  return list.join(',') || 'ulaw,alaw';
}
const safeText = (v, max) => str(v, max).replace(/[\r\n;#\[\]]/g, ' ');

// changed fields of an edit, for the audit log: { field: [old, new] }; secrets only say that they changed
function diff(cur, next) {
  const out = {};
  const norm = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  for (const k of Object.keys(next)) {
    if (!(k in cur) || norm(cur[k]) === norm(next[k])) continue;
    out[k] = /pass|secret/i.test(k) ? ['***', '*** (changed)'] : [cur[k], next[k]];
  }
  return out;
}
const genPassword = (n = 16) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n);
function suggestCli() {
  // Plausible 10-digit Indian mobile-format number (6-9 start)
  const first = 6 + crypto.randomInt(4);
  let s = String(first);
  for (let i = 0; i < 9; i++) s += crypto.randomInt(10);
  return s;
}

module.exports = { Bad, wrap, str, int, bool, name, diff, HOST_RE, IP_RE, codecs, safeText, genPassword, suggestCli };
