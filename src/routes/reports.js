'use strict';
const router = require('express').Router();
const { q } = require('../db');
const tracker = require('../tracker');
const { wrap, str, int } = require('./util');

const DISPS = ['ANSWERED', 'BUSY', 'NO_ANSWER', 'CANCEL', 'CONGESTION', 'FAILED',
  'CHANNEL_LIMIT', 'TRUNK_LIMIT', 'BLOCKED', 'NO_ROUTE', 'INVALID', 'OFF_HOURS', 'NO_HEADER', 'INVALID_DID', 'SIP_DOWN'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateRange(qs) {
  const t = tracker.today();
  const from = DATE_RE.test(qs.from || '') ? qs.from : t;
  const to = DATE_RE.test(qs.to || '') ? qs.to : t;
  return { from, to };
}

function callFilter(qs) {
  const { from, to } = dateRange(qs);
  const tz = require('../config').statsTz.replace(/[^A-Za-z0-9_/+\-]/g, '');
  const where = [`start_time >= ($1::date)::timestamp AT TIME ZONE '${tz}'`,
    `start_time < ($2::date + 1)::timestamp AT TIME ZONE '${tz}'`];
  const args = [from, to];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', '$' + args.length)); };
  if (qs.process) add('process_code = ?', str(qs.process, 32));
  if (qs.trunk) add('trunk_name = ?', str(qs.trunk, 32));
  if (qs.disposition && DISPS.includes(qs.disposition)) add('disposition = ?', qs.disposition);
  if (qs.direction === 'in' || qs.direction === 'out') add('direction = ?', qs.direction);
  if (qs.did) add('did = ?', str(qs.did, 20).replace(/[^0-9]/g, ''));
  if (qs.number) {
    args.push(`%${str(qs.number, 32).replace(/[%_\\]/g, '')}%`);
    where.push(`(dialed LIKE $${args.length} OR sent_number LIKE $${args.length})`);
  }
  return { sql: where.join(' AND '), args, from, to };
}

router.get('/calls', wrap(async (req, res) => {
  const f = callFilter(req.query);
  const size = int(req.query.size, { min: 10, max: 500, def: 50 });
  const page = int(req.query.page, { min: 1, max: 100000, def: 1 });
  const dir = req.query.sort === 'asc' ? 'ASC' : 'DESC';   // by call time, newest first by default
  const [rows, count, disp] = await Promise.all([
    q(`SELECT * FROM calls WHERE ${f.sql} ORDER BY start_time ${dir}, id ${dir} LIMIT ${size} OFFSET ${(page - 1) * size}`, f.args),
    q(`SELECT count(*)::int AS n, coalesce(sum(bill_sec),0)::bigint AS talk FROM calls WHERE ${f.sql}`, f.args),
    q(`SELECT disposition, count(*)::int AS n FROM calls WHERE ${f.sql} GROUP BY 1 ORDER BY 2 DESC`, f.args),
  ]);
  res.json({ rows: rows.rows, total: count.rows[0].n, talkSec: +count.rows[0].talk, byDisposition: disp.rows, page, size, from: f.from, to: f.to });
}));

router.get('/calls.csv', wrap(async (req, res) => {
  const f = callFilter(req.query);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="cdr_${f.from}_${f.to}.csv"`);
  const cols = ['start_time', 'answer_time', 'end_time', 'direction', 'process_code', 'trunk_name', 'src_ip', 'cli_in', 'cli_out',
    'dialed', 'sent_number', 'did', 'hdr_status', 'hdr_did', 'hdr_num', 'disposition', 'disposition_code', 'dialstatus', 'hangup_cause', 'ring_sec', 'bill_sec', 'duration', 'uniqueid'];
  res.write(cols.join(',') + '\n');
  const esc = (v) => { if (v == null) return ''; const s = v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  // disposition_code = the custom code shown in the UI (e.g. LIMIT_REACH), else the internal code
  const custom = Object.fromEntries((await q(`SELECT code, custom_code FROM dispositions`)).rows.map((d) => [d.code, d.custom_code || d.code]));
  let last = 0;
  // stream in chunks of 5000 by id so huge exports do not load into memory
  for (;;) {
    const { rows } = await q(`SELECT id,${cols.filter((c) => c !== 'disposition_code')} FROM calls WHERE ${f.sql} AND id > ${last} ORDER BY id LIMIT 5000`, f.args);
    if (!rows.length) break;
    for (const r of rows) r.disposition_code = custom[r.disposition] || r.disposition;
    for (const r of rows) res.write(cols.map((c) => esc(r[c])).join(',') + '\n');
    last = rows[rows.length - 1].id;
  }
  res.end();
}));

router.get('/daily', wrap(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const scope = ['trunk', 'did'].includes(req.query.scope) ? req.query.scope : 'process';
  const args = [from, to, scope];
  let extra = '';
  if (req.query.ref) { args.push(str(req.query.ref, 32)); extra = ' AND ref=$4'; }
  const { rows } = await q(`SELECT to_char(day,'YYYY-MM-DD') AS day, ref, total, answered, busy, no_answer, cancel, congestion, failed,
      channel_limit, trunk_limit, blocked, no_route, invalid, off_hours, no_header, invalid_did, sip_down, talk_sec, peak_channels
    FROM daily_stats WHERE day BETWEEN $1 AND $2 AND scope=$3${extra} ORDER BY day DESC, ref`, args);
  res.json({ from, to, scope, rows });
}));

// Usage over time for the line chart: per bucket and per process / trunk / DID, the peak channels in use
// (exact, from call start/end), calls started and calls answered. Top 7 refs by calls, the rest folded into "Other".
const USAGE_COL = { process: 'process_code', trunk: 'trunk_name', did: 'did' };
router.get('/usage', wrap(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const scope = USAGE_COL[req.query.scope] ? req.query.scope : 'process';
  const col = USAGE_COL[scope];
  const tz = require('../config').statsTz.replace(/[^A-Za-z0-9_/+\-]/g, '');
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  let step = int(req.query.step, { min: 0, max: 1440, def: 0 });   // minutes, 0 = auto
  if (![5, 15, 60, 1440].includes(step)) step = days <= 1 ? 15 : days <= 7 ? 60 : 1440;
  while (days * 1440 / step > 2000) step = step === 5 ? 15 : step === 15 ? 60 : 1440;   // cap the point count
  const lo = `($1::date)::timestamp AT TIME ZONE '${tz}'`, hi = `($2::date + 1)::timestamp AT TIME ZONE '${tz}'`;
  const args = [from, to];
  let where = `${col} IS NOT NULL AND ${col} <> '' AND start_time < ${hi} AND end_time >= ${lo}`;
  if (req.query.ref) { args.push(str(req.query.ref, 32)); where += ` AND ${col} = $${args.length}`; }
  const top = (await q(`SELECT ${col} AS ref FROM calls WHERE ${where} GROUP BY 1 ORDER BY count(*) DESC LIMIT 7`, args)).rows.map((r) => r.ref);
  args.push(top);
  const ref = `CASE WHEN ${col} = ANY($${args.length}) THEN ${col} ELSE '' END`;   // '' = Other
  // bucket number from the range start, in seconds of local time
  const bk = (t) => `floor(extract(epoch FROM (${t} AT TIME ZONE '${tz}') - ($1::date)::timestamp) / ${step * 60})::int`;
  const [conc, counts] = await Promise.all([
    q(`WITH c AS (SELECT ${ref} AS ref, greatest(start_time, ${lo}) AS s, least(end_time, ${hi}) AS e FROM calls WHERE ${where}),
        ev AS (SELECT ref, s AS t, 1 AS d FROM c UNION ALL SELECT ref, e, -1 FROM c),
        run AS (SELECT ref, t, sum(d) OVER (PARTITION BY ref ORDER BY t, d ROWS UNBOUNDED PRECEDING)::int AS n, d FROM ev)
      SELECT ref, ${bk('t')} AS b, max(n) AS peak, (array_agg(n ORDER BY t DESC, d DESC, n * d DESC))[1] AS last FROM run GROUP BY 1, 2`, args),
    q(`SELECT ${ref} AS ref, ${bk('start_time')} AS b, count(*)::int AS calls, count(answer_time)::int AS answered
      FROM calls WHERE ${where} AND start_time >= ${lo} GROUP BY 1, 2`, args),
  ]);
  res.json({ from, to, scope, step, buckets: Math.ceil(days * 1440 / step), refs: top, conc: conc.rows, counts: counts.rows });
}));

router.get('/dispositions', wrap(async (req, res) => {
  res.json((await q('SELECT * FROM dispositions ORDER BY sort')).rows);
}));

module.exports = router;
