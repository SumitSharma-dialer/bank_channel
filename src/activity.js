'use strict';
// Activity log: every /api request of a signed-in user (who, when, IP, what), plus sign-in / sign-out and failed
// sign-ins. `detail` says what was viewed (filters, which trunk / process) or changed (object, old -> new values from
// the audit entries the request wrote). Only super admins can read it (Activity page). Background refreshes the UI marks with X-Poll
// (timers on the System / Processes / Diagnostics pages) are not logged, and the same GET of the same session is
// logged at most once a minute, so the log shows what people did, not timer noise.
const { q, requestCtx } = require('./db');
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
  ['GET', /^\/reports\/dispositions$/, 'Opened the console'],
  ['GET', /^\/system\/(health|config-preview)$/, 'Opened system page'],
  ['GET', /^\/system\/resources\/history$/, 'Viewed resource history'],
  ['GET', /^\/system\/cli\//, 'Ran Asterisk CLI view'],
  ['POST', /^\/system\/apply$/, 'Re-applied Asterisk config'],
  ['GET', /^\/activity/, 'Viewed activity log'],
];
const nameOf = (method, path) => (NAMES.find(([m, re]) => m === method && re.test(path)) || [])[2] || null;

function write(r) {
  q(`INSERT INTO activity_log(username, role, sid, ip, method, path, query, status, ms, action, detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [r.username || null, r.role || null, r.sid || null, r.ip || null, r.method, String(r.path).slice(0, 200), r.query || null,
      r.status || null, r.ms == null ? null : r.ms, r.action ? String(r.action).slice(0, 64) : null, r.detail ? String(r.detail).slice(0, 2000) : null])
    .catch((e) => console.error('[activity]', e.message));
}

// ---- readable detail
const short = (v) => {
  const t = v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') || '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
};
const field = (k) => k.replace(/_/g, ' ');

// what was viewed: the filters of a GET, in words
const QUERY_WORDS = {
  process: 'process', trunk: 'trunk', disposition: 'disposition', did: 'DID', user: 'user', scope: 'by', metric: 'metric',
  step: 'step', target: 'target', host: 'host', method: 'method', tool: 'tool', what: '', levels: 'levels', lines: 'lines',
};
function viewDetail(query) {
  const p = new URLSearchParams(query || '');
  const out = [];
  const from = p.get('from'), to = p.get('to');
  if (from || to) out.push(from && to && from !== to ? `${from} → ${to}` : from || to);
  for (const [k, v] of p) {
    if (!v || ['from', 'to', 'size', 'sort', 'page', 'writes', 'failed', 'id'].includes(k)) continue;
    if (k === 'direction') out.push(v === 'in' ? 'inbound' : 'outbound');
    else if (k === 'number') out.push(`number contains ${v}`);
    else if (k === 'q') out.push(`search "${v}"`);
    else if (k === 'hours') out.push(`last ${v} h`);
    else if (k === 'all') out.push('incl. ended');
    else if (k in QUERY_WORDS) out.push(`${QUERY_WORDS[k]} ${v}`.trim());
    else out.push(`${k} ${v}`);
  }
  if (p.get('sort') === 'asc') out.push('oldest first');
  if (+p.get('page') > 1) out.push(`page ${p.get('page')}`);
  return out.join(' · ');
}

// what was changed: one audit entry in words, e.g. "trunk airtel: max channels 30 → 60"
const ENTITY = { admin: 'user', cause_rules: 'cause rules', diag: '' };
function changeDetail({ entity, entityId, details }) {
  const d = details || {};
  const who = d.name || d.code || d.username || (entityId != null ? `#${entityId}` : '');
  const head = [ENTITY[entity] ?? entity, who].filter(Boolean).join(' ');
  const parts = [];
  for (const [k, v] of Object.entries(d.changes || {})) parts.push(`${field(k)} ${short(v[0])} → ${short(v[1])}`);
  for (const [k, v] of Object.entries(d)) {
    if (['name', 'code', 'username', 'changes', 'ip'].includes(k) || v == null || v === '' || (k === 'sessionsEnded' && !v)) continue;
    parts.push(`${field(k)} ${short(v)}`);
  }
  if (d.changes && !Object.keys(d.changes).length && !parts.length) parts.push('saved without changes');
  return head + (parts.length ? `: ${parts.join(', ')}` : '');
}

// trunk / process named in the path (/trunks/4, /processes/7/header-log)
async function pathObject(path) {
  const m = /^\/(trunks|processes)\/(\d+)/.exec(path);
  if (!m) return '';
  const col = m[1] === 'trunks' ? 'name' : 'code';
  const r = (await q(`SELECT ${col} AS n FROM ${m[1]} WHERE id=$1`, [+m[2]]).catch(() => ({ rows: [] }))).rows[0];
  return `${m[1] === 'trunks' ? 'trunk' : 'process'} ${r ? r.n : '#' + m[2]}`;
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
  const ctx = { audits: [], error: null };
  const json = res.json.bind(res);
  res.json = (b) => { if (b && b.error) ctx.error = b.error; return json(b); };
  // a trunk / process deleted by this request has no name afterwards: look it up first
  const named = req.method === 'GET' ? null : pathObject(path);
  res.on('finish', async () => {
    const query = cleanQuery(req.url), status = res.statusCode;
    let detail;
    if (status >= 400) detail = `${status === 403 ? 'refused' : 'failed'}${ctx.error ? ': ' + ctx.error : ''}`;
    else if (ctx.audits.length) detail = ctx.audits.map(changeDetail).join('; ');
    else {
      const obj = await (named || pathObject(path));
      const cli = /^\/system\/cli\/(\w+)/.exec(path);
      detail = [obj, cli && cli[1], viewDetail(query)].filter(Boolean).join(' · ');
    }
    write({ username: a.user, role: a.role, sid: a.sid, ip: clientIp(req), method: req.method, path: '/api' + path, query,
      status, ms: Date.now() - t0, action: nameOf(req.method, path), detail });
  });
  requestCtx.run(ctx, next);
}

// sign-in / sign-out (outside requireAuth) and live feed connects (raw http request: no req.path)
const event = (req, { user, role, sid, status, action, detail }) =>
  write({ username: user, role, sid, ip: clientIp(req), method: req.method, path: req.path || req.url.split('?')[0], status, action, detail });

module.exports = { middleware, event, nameOf, cleanQuery, viewDetail, changeDetail };
