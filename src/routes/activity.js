'use strict';
// Activity page (super admins only): what every user did (activity_log: requests, sign-ins) and what they changed
// (audit_log: the saved values). Filters: day range, user, text.
const router = require('express').Router();
const { q } = require('../db');
const tracker = require('../tracker');
const { wrap, str, int } = require('./util');
const { changeDetail } = require('../activity');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const tz = () => require('../config').statsTz.replace(/[^A-Za-z0-9_/+\-]/g, '');

function filter(qs, cols) {
  const t = tracker.today();
  const from = DATE_RE.test(qs.from || '') ? qs.from : t, to = DATE_RE.test(qs.to || '') ? qs.to : t;
  const args = [from, to];
  const where = [`at >= ($1::date)::timestamp AT TIME ZONE '${tz()}'`, `at < ($2::date + 1)::timestamp AT TIME ZONE '${tz()}'`];
  if (qs.user) { args.push(str(qs.user, 64)); where.push(`${cols.user} = $${args.length}`); }
  if (qs.q) {
    args.push(`%${str(qs.q, 100).replace(/[%_\\]/g, '')}%`);
    where.push(`(${cols.text.map((c) => `${c} ILIKE $${args.length}`).join(' OR ')})`);
  }
  return { sql: where.join(' AND '), args, from, to };
}
const paging = (qs) => {
  const size = int(qs.size, { min: 10, max: 500, def: 100 }), page = int(qs.page, { min: 1, max: 100000, def: 1 });
  return { size, page, sql: `LIMIT ${size} OFFSET ${(page - 1) * size}` };
};

router.get('/', wrap(async (req, res) => {
  const f = filter(req.query, { user: 'username', text: ['action', 'detail', 'path', 'query', 'ip', 'username'] });
  if (req.query.writes === '1') f.sql += ` AND method <> 'GET'`;
  if (req.query.failed === '1') f.sql += ' AND status >= 400';
  const p = paging(req.query);
  const [rows, count, users] = await Promise.all([
    q(`SELECT * FROM activity_log WHERE ${f.sql} ORDER BY at DESC, id DESC ${p.sql}`, f.args),
    q(`SELECT count(*)::int AS n FROM activity_log WHERE ${f.sql}`, f.args),
    q(`SELECT username FROM admins UNION SELECT DISTINCT username FROM activity_log WHERE username IS NOT NULL ORDER BY 1`),
  ]);
  res.json({ rows: rows.rows.map((r) => ({ ...r, id: +r.id, sid: r.sid == null ? null : +r.sid })), total: count.rows[0].n,
    page: p.page, size: p.size, from: f.from, to: f.to, users: users.rows.map((r) => r.username) });
}));

router.get('/changes', wrap(async (req, res) => {
  const f = filter(req.query, { user: 'admin', text: ['action', 'entity', 'entity_id', 'admin', 'details::text'] });
  const p = paging(req.query);
  const [rows, count] = await Promise.all([
    q(`SELECT * FROM audit_log WHERE ${f.sql} ORDER BY at DESC, id DESC ${p.sql}`, f.args),
    q(`SELECT count(*)::int AS n FROM audit_log WHERE ${f.sql}`, f.args),
  ]);
  res.json({ rows: rows.rows.map((r) => ({ ...r, id: +r.id, detail: changeDetail({ entity: r.entity, entityId: r.entity_id, details: r.details }) })), total: count.rows[0].n, page: p.page, size: p.size, from: f.from, to: f.to });
}));

module.exports = router;
