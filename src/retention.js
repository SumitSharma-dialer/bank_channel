'use strict';
// Database history retention: rows older than RETENTION_DAYS (default 5) are deleted every 6 hours.
// daily_stats is kept on purpose (Reports; one small row per process / trunk / DID per day).
// Deletes run in batches so a big backlog never holds long locks on the calls table.
const { q } = require('./db');

const DAYS = Math.max(1, +(process.env.RETENTION_DAYS || 5));
const BATCH = 5000;
const EVERY_MS = 6 * 3600 * 1000;

// table -> rows that may go (only rows older than the cutoff $1)
const RULES = [
  ['calls', 'start_time < $1'],
  ['cdr', 'calldate < $1'],
  ['audit_log', 'at < $1'],
  ['diag_issues', 'closed_at < $1'],   // open issues are kept however old
  ['alert_log', 'at < $1'],
];

async function run() {
  const cutoff = new Date(Date.now() - DAYS * 86400 * 1000);
  const deleted = {};
  for (const [table, where] of RULES) {
    if (!(await q('SELECT to_regclass($1) AS t', [table])).rows[0].t) continue;
    let n = 0, r;
    do {
      r = await q(`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${BATCH})`, [cutoff]);
      n += r.rowCount;
    } while (r.rowCount === BATCH);
    if (n) deleted[table] = n;
  }
  if (Object.keys(deleted).length) console.log(`[retention] older than ${DAYS} days deleted:`, JSON.stringify(deleted));
  return { days: DAYS, cutoff, deleted };
}

function start() {
  const go = () => run().catch((e) => console.error('[retention]', e.message));
  setTimeout(go, 60 * 1000);   // shortly after start, then every 6 h
  setInterval(go, EVERY_MS);
}

module.exports = { start, run, DAYS, RULES };
