'use strict';
// Issue tracker: every 30 s run health checks; a check that fails opens an issue (diag_issues row), and the issue is
// closed when the check passes again. Open issues are shown on the Diagnostics page and counted in the nav badge.
const { q } = require('../db');
const redis = require('../redis');
const ari = require('../ari');
const applier = require('../asterisk/apply');
const tracker = require('../tracker');
const alerts = require('./alerts');

const WINDOW_MIN = 15;   // call-based checks look at the last 15 minutes
let open = new Map();     // key -> row
let lastRun = null;
let loaded = false;
const alertedAt = new Map();   // key -> last alert time (opened / reminder), for reminders

// -> [{ key, severity: 'critical'|'warning', title, detail, hint }]
async function checks() {
  const out = [];
  const add = (key, severity, title, detail, hint) => out.push({ key, severity, title, detail, hint });

  if (!ari.connected) add('ari_down', 'critical', 'Asterisk ARI disconnected',
    'Live counters and CDR are not being recorded.', 'Check `systemctl status asterisk` and ARI user/password in .env and ari.conf.');
  const a = applier.status();
  if (a.ok === false) add('apply_failed', 'critical', 'Last config apply to Asterisk failed', a.error,
    'Open System → Re-apply config; check the error and /etc/asterisk/sipdist permissions.');
  try { await redis.ping(); } catch (e) { add('redis_down', 'critical', 'Redis not reachable', e.message, 'Check `systemctl status redis-server` and REDIS_* in .env.'); }

  let snap = null;
  try { snap = await tracker.snapshot(); } catch { /* redis down: reported above */ }
  if (snap) {
    for (const t of snap.trunks.filter((x) => x.active)) {
      if (t.state === 'offline' || t.state === 'unavailable') add(`sip_down:${t.name}`, 'critical', `SIP DOWN: trunk ${t.name}`,
        `Endpoint t_${t.name} is ${t.state} (SIP OPTIONS qualify gets no reply). Calls fail with SIP_DOWN.`,
        'Check carrier IP/port, firewall, network route; run a SIP trace filtered on the carrier IP.');
      if (t.reg !== 'n/a' && t.reg !== 'unknown' && !/^registered$/i.test(t.reg)) add(`reg:${t.name}`, 'critical', `Trunk ${t.name} not registered`,
        `Registration state: ${t.reg}.`, 'Check trunk username/password and the carrier\'s 401/403 replies in a SIP trace.');
      if (t.max && t.live >= t.max * 0.9) add(`trunk_full:${t.name}`, 'warning', `Trunk ${t.name} near its channel limit`,
        `${t.live} of ${t.max} channels in use.`, 'Raise max channels on the trunk or move processes to another trunk.');
    }
    for (const p of snap.processes.filter((x) => x.active)) {
      if (p.limit && p.live >= p.limit * 0.9) add(`proc_full:${p.code}`, 'warning', `Process ${p.code} near its channel limit`,
        `${p.live} of ${p.limit} channels in use — new calls get LIMIT_REACH.`, 'Raise the process channel limit or ask the customer to lower concurrency.');
    }
  }

  // call results in the last WINDOW_MIN minutes
  const { rows } = await q(`SELECT process_code, trunk_name, disposition, count(*)::int AS n FROM calls
    WHERE start_time > now() - interval '${WINDOW_MIN} minutes' GROUP BY 1,2,3`);
  const by = (field) => {
    const m = {};
    for (const r of rows) {
      if (!r[field]) continue;
      const o = m[r[field]] || (m[r[field]] = {});
      o[r.disposition] = (o[r.disposition] || 0) + r.n;
    }
    return m;
  };
  const sum = (o, ks) => ks.reduce((s, k) => s + (o[k] || 0), 0);
  for (const [code, d] of Object.entries(by('process_code'))) {
    if (d.CHANNEL_LIMIT) add(`limit:${code}`, 'warning', `LIMIT_REACH on process ${code}`,
      `${d.CHANNEL_LIMIT} call(s) rejected in the last ${WINDOW_MIN} min because the process channel limit was full.`,
      'Raise the limit on the Processes page if the customer bought more channels.');
    const bad = sum(d, ['NO_HEADER', 'INVALID_DID', 'INVALID']);
    if (bad >= 5) add(`badreq:${code}`, 'warning', `Process ${code} sends bad calls`,
      `${bad} call(s) in the last ${WINDOW_MIN} min rejected as NO_HEADER / INVALID_DID / INVALID.`,
      'The customer dialplan is wrong: check X-DID / X-Number headers and the dummy number (Processes → peer config).');
  }
  for (const [name, d] of Object.entries(by('trunk_name'))) {
    if (d.SIP_DOWN) add(`sipdown_calls:${name}`, 'critical', `SIP_DOWN calls on trunk ${name}`,
      `${d.SIP_DOWN} call(s) in the last ${WINDOW_MIN} min could not reach the trunk.`, 'See the trunk state and a SIP trace on the carrier IP.');
    if (d.TRUNK_LIMIT) add(`tlimit:${name}`, 'warning', `Trunk ${name} limit reached`,
      `${d.TRUNK_LIMIT} call(s) rejected in the last ${WINDOW_MIN} min (TRUNK_LIMIT).`, 'Raise max channels on the trunk.');
    const reached = sum(d, ['ANSWERED', 'BUSY', 'NO_ANSWER', 'CANCEL', 'CONGESTION', 'FAILED', 'SIP_DOWN']);
    const failed = sum(d, ['CONGESTION', 'FAILED', 'SIP_DOWN']);
    if (reached >= 10 && failed / reached >= 0.5) add(`failrate:${name}`, 'critical', `High failure rate on trunk ${name}`,
      `${failed} of ${reached} calls (${Math.round(100 * failed / reached)}%) failed in the last ${WINDOW_MIN} min.`,
      'Check hangup causes in the CDR and the carrier replies (503/403/408) in a SIP trace.');
    else if (reached >= 30 && (d.ANSWERED || 0) / reached < 0.05) add(`lowasr:${name}`, 'warning', `Very low ASR on trunk ${name}`,
      `${d.ANSWERED || 0} of ${reached} calls answered in the last ${WINDOW_MIN} min.`, 'Check number format (prefix / strip digits) and caller ID acceptance with the carrier.');
  }
  return out;
}

async function load() {
  const { rows } = await q('SELECT * FROM diag_issues WHERE closed_at IS NULL');
  open = new Map(rows.map((r) => [r.key, r]));
  for (const k of open.keys()) alertedAt.set(k, Date.now());   // already open before this start: no new alert
  loaded = true;
}

async function run() {
  if (!loaded) await load();
  const now = await checks();
  const seen = new Set();
  const events = [];   // -> one grouped Slack / email message
  for (const c of now) {
    seen.add(c.key);
    const cur = open.get(c.key);
    if (cur) {
      if (cur.detail !== c.detail || cur.severity !== c.severity) {
        const { rows } = await q('UPDATE diag_issues SET detail=$2, severity=$3, last_seen=now() WHERE id=$1 RETURNING *', [cur.id, c.detail, c.severity]);
        open.set(c.key, rows[0]);
        if (cur.severity !== 'critical' && c.severity === 'critical') { events.push({ kind: 'opened', issue: rows[0] }); alertedAt.set(c.key, Date.now()); }
      } else await q('UPDATE diag_issues SET last_seen=now() WHERE id=$1', [cur.id]);
      continue;
    }
    const { rows } = await q(`INSERT INTO diag_issues(key,severity,title,detail,hint) VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [c.key, c.severity, c.title, c.detail, c.hint]);
    open.set(c.key, rows[0]);
    events.push({ kind: 'opened', issue: rows[0] }); alertedAt.set(c.key, Date.now());
    console.warn(`[issue] OPEN ${c.severity} ${c.title}: ${c.detail}`);
  }
  for (const [key, r] of open) {
    if (seen.has(key)) continue;
    await q('UPDATE diag_issues SET closed_at=now() WHERE id=$1', [r.id]);
    open.delete(key); alertedAt.delete(key);
    events.push({ kind: 'closed', issue: { ...r, closed_at: new Date() } });
    console.log(`[issue] CLOSED ${r.title}`);
  }
  // reminders: critical issues still open, every ALERT_REMIND_MIN minutes
  const every = alerts.conf.remindMin * 60e3;
  if (every) {
    for (const [key, r] of open) {
      if (r.severity !== 'critical' || Date.now() - (alertedAt.get(key) || 0) < every) continue;
      events.push({ kind: 'reminder', issue: r }); alertedAt.set(key, Date.now());
    }
  }
  if (events.length) alerts.notify(events).catch((e) => console.error('[alert]', e.message));
  lastRun = Date.now();
}

function summary() {
  let critical = 0, warning = 0;
  for (const r of open.values()) r.severity === 'critical' ? critical++ : warning++;
  return { critical, warning };
}

async function list(limit = 200) {
  const { rows } = await q(`SELECT * FROM diag_issues ORDER BY (closed_at IS NULL) DESC, opened_at DESC LIMIT $1`, [limit]);
  return { lastRun, open: rows.filter((r) => !r.closed_at), history: rows.filter((r) => r.closed_at) };
}

function start() {
  const tick = () => run().catch((e) => console.error('[issue] check failed:', e.message));
  setTimeout(tick, 15000);   // let ARI connect and trunk state load first
  setInterval(tick, 30000);
}

module.exports = { start, run, list, summary, checks };
