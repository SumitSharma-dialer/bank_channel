'use strict';
// Slack + Gmail alerts for the issue tracker (src/diag/issues.js). Configured on the Alerts page (table alert_settings);
// anything not set there falls back to .env:
//   ALERT_SLACK_WEBHOOK        https://hooks.slack.com/services/...
//   ALERT_GMAIL_USER           sender Gmail address
//   ALERT_GMAIL_APP_PASSWORD   16-char Google App Password (needs 2-Step Verification)
//   ALERT_EMAIL_TO             comma-separated recipients
// Optional: ALERT_WARNINGS_EMAIL=1 (warnings by email too; default Slack only), ALERT_REMIND_MIN=30 (0 = off),
//           ALERT_RESOLVED=0 (no "resolved" messages), ALERT_NAME (server name in messages).
// The page can also route each alert type (issue key prefix) to Slack, email, both or off.
const os = require('os');
const cfg = require('../config');
let { q: dbq } = require('../db');
const q = (...a) => dbq(...a);

const env = process.env;
const fromEnv = () => ({
  slack: (env.ALERT_SLACK_WEBHOOK || '').trim(),
  slackMention: env.ALERT_SLACK_MENTION === '1',
  gmailUser: (env.ALERT_GMAIL_USER || '').trim(),
  gmailPass: (env.ALERT_GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),   // Google shows it as "abcd efgh ijkl mnop"
  to: (env.ALERT_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean),
  warningsEmail: env.ALERT_WARNINGS_EMAIL === '1',
  remindMin: Math.max(0, +(env.ALERT_REMIND_MIN ?? 30) || 0),
  resolved: env.ALERT_RESOLVED !== '0',
  name: env.ALERT_NAME || `SIPDist ${cfg.publicIp !== '127.0.0.1' ? cfg.publicIp : os.hostname()}`,
  routes: {},
});
const conf = fromEnv();
let mailer = null;
const source = {};   // field -> 'ui' when it comes from alert_settings

// Alert types = issue key prefixes from src/diag/issues.js
const TYPES = [
  { type: 'ari_down', severity: 'critical', label: 'Asterisk ARI disconnected', about: 'Live counters and CDR stop.' },
  { type: 'apply_failed', severity: 'critical', label: 'Config apply to Asterisk failed', about: 'Last trunk / process change did not reach Asterisk.' },
  { type: 'redis_down', severity: 'critical', label: 'Redis not reachable', about: 'Channel counting is down.' },
  { type: 'sip_down', severity: 'critical', label: 'SIP trunk down', about: 'Trunk does not answer SIP OPTIONS.' },
  { type: 'reg', severity: 'critical', label: 'Trunk not registered', about: 'Carrier rejects the registration.' },
  { type: 'sipdown_calls', severity: 'critical', label: 'SIP_DOWN calls on a trunk', about: 'Calls could not reach the trunk (last 15 min).' },
  { type: 'failrate', severity: 'critical', label: 'High failure rate on a trunk', about: '≥50% of ≥10 calls failed (last 15 min).' },
  { type: 'trunk_full', severity: 'warning', label: 'Trunk near its channel limit', about: '≥90% of max channels in use.' },
  { type: 'proc_full', severity: 'warning', label: 'Process near its channel limit', about: '≥90% of the process limit in use.' },
  { type: 'limit', severity: 'warning', label: 'LIMIT_REACH on a process', about: 'Calls rejected: process channel limit full.' },
  { type: 'tlimit', severity: 'warning', label: 'Trunk limit reached', about: 'Calls rejected with TRUNK_LIMIT.' },
  { type: 'badreq', severity: 'warning', label: 'Process sends bad calls', about: '≥5 NO_HEADER / INVALID_DID / INVALID (last 15 min).' },
  { type: 'lowasr', severity: 'warning', label: 'Very low ASR on a trunk', about: '<5% of ≥30 calls answered (last 15 min).' },
];
const ROUTES = ['both', 'slack', 'email', 'off'];
const SEVERITY = Object.fromEntries(TYPES.map((t) => [t.type, t.severity]));
const typeOf = (issue) => String(issue.key || '').split(':')[0];
const defaultRoute = (severity) => (severity === 'critical' || conf.warningsEmail ? 'both' : 'slack');
// 'both' | 'slack' | 'email' | 'off' for this issue
function routeOf(issue) {
  const r = conf.routes[typeOf(issue)];
  return ROUTES.includes(r) ? r : defaultRoute(issue.severity || SEVERITY[typeOf(issue)]);
}

// alert_settings row (NULL fields) over .env
const COLS = { slack: 'slack_webhook', slackMention: 'slack_mention', gmailUser: 'gmail_user', gmailPass: 'gmail_pass', to: 'email_to',
  warningsEmail: 'warnings_email', remindMin: 'remind_min', resolved: 'resolved', name: 'name' };
async function reload() {
  const row = (await q('SELECT * FROM alert_settings WHERE id=1')).rows[0] || {};
  const c = fromEnv();
  for (const k of Object.keys(source)) delete source[k];
  for (const [k, col] of Object.entries(COLS)) {
    if (row[col] == null) continue;
    c[k] = k === 'to' ? String(row[col]).split(',').map((s) => s.trim()).filter(Boolean) : row[col];
    source[k] = 'ui';
  }
  c.routes = row.routes || {};
  if (c.gmailUser !== conf.gmailUser || c.gmailPass !== conf.gmailPass) mailer = null;
  Object.assign(conf, c);
}
let ready = null;
const ensure = () => (ready ||= reload().catch((e) => { ready = null; console.error('[alert] settings', e.message); }));

const SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/;
const slackOn = () => SLACK_RE.test(conf.slack);
const emailOn = () => !!(conf.gmailUser && conf.gmailPass && conf.to.length);

function transport() {
  if (!mailer) {
    mailer = require('nodemailer').createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: conf.gmailUser, pass: conf.gmailPass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    });
  }
  return mailer;
}

const fmtMin = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
const ICON = { critical: ':red_circle:', warning: ':warning:', resolved: ':large_green_circle:', reminder: ':rotating_light:' };
const WORD = { critical: 'CRITICAL', warning: 'WARNING', resolved: 'RESOLVED', reminder: 'STILL OPEN' };

// events: [{ kind: 'opened'|'closed'|'reminder', issue: diag_issues row }]
function lines(events) {
  return events.map(({ kind, issue: i }) => {
    const tag = kind === 'closed' ? 'resolved' : kind === 'reminder' ? 'reminder' : i.severity;
    const age = kind === 'closed' ? ` (lasted ${fmtMin(new Date(i.closed_at || Date.now()) - new Date(i.opened_at))})`
      : kind === 'reminder' ? ` (open ${fmtMin(Date.now() - new Date(i.opened_at))})` : '';
    return { tag, title: `${WORD[tag]}: ${i.title}${age}`, detail: kind === 'closed' ? '' : i.detail || '', hint: kind === 'opened' ? i.hint || '' : '' };
  });
}

async function postSlack(events, test) {
  const ls = lines(events);
  const text = test ? `:white_check_mark: *${conf.name}*: test alert from the Diagnostics page — Slack alerts work.`
    : `${conf.slackMention && ls.some((l) => l.tag === 'critical' || l.tag === 'reminder') ? '<!channel> ' : ''}*${conf.name}*\n` + ls.map((l) => `${ICON[l.tag]} *${l.title}*${l.detail ? `\n${l.detail}` : ''}${l.hint ? `\n_→ ${l.hint}_` : ''}`).join('\n\n');
  const res = await fetch(conf.slack, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, unfurl_links: false }), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Slack ${res.status} ${(await res.text()).slice(0, 120)}`);
}

async function sendEmail(events, test) {
  const ls = lines(events);
  const worst = ls.find((l) => l.tag === 'critical') || ls.find((l) => l.tag === 'reminder') || ls[0];
  const subject = test ? `[${conf.name}] Test alert` : `[${conf.name}] ${worst.title}${ls.length > 1 ? ` (+${ls.length - 1} more)` : ''}`;
  const text = test ? `Test alert from the SIPDist Diagnostics page. Email alerts work.\n`
    : ls.map((l) => `${l.title}${l.detail ? `\n  ${l.detail}` : ''}${l.hint ? `\n  -> ${l.hint}` : ''}`).join('\n\n') +
      `\n\n--\n${conf.name} · Diagnostics: http://${cfg.publicIp}:${cfg.http.port}/#/diag\n`;
  await transport().sendMail({ from: `"SIPDist alerts" <${conf.gmailUser}>`, to: conf.to.join(', '), subject, text });
}

async function log(channel, kind, subject, err) {
  try {
    await q('INSERT INTO alert_log(channel, kind, subject, ok, error) VALUES($1,$2,$3,$4,$5)',
      [channel, kind, String(subject).slice(0, 300), !err, err ? String(err.message || err).slice(0, 500) : null]);
  } catch (e) { console.error('[alert] log', e.message); }
}

// Send one grouped message per channel; each alert type goes to the channels picked on the Alerts page
// (default: critical -> Slack + email, warnings -> Slack, + email with ALERT_WARNINGS_EMAIL=1).
async function notify(events) {
  await ensure();
  if (!conf.resolved) events = events.filter((e) => e.kind !== 'closed');
  const to = (ch) => events.filter((e) => { const r = routeOf(e.issue); return r === 'both' || r === ch; });
  const send = async (ch, on, evs, fn) => {
    if (!on || !evs.length) return;
    const kind = evs.map((e) => e.kind).sort().filter((k, i, a) => a.indexOf(k) === i).join('+');
    const subject = lines(evs).map((l) => l.title).join(' | ');
    try { await fn(evs); await log(ch, kind, subject); }
    catch (e) { console.error(`[alert] ${ch}`, e.message); await log(ch, kind, subject, e); }
  };
  await send('slack', slackOn(), to('slack'), postSlack);
  await send('email', emailOn(), to('email'), sendEmail);
}

async function test(channel) {
  await ensure();
  if (channel === 'slack') {
    if (!slackOn()) throw Object.assign(new Error('Slack is not configured: paste the webhook URL on the Alerts page and save'), { status: 400 });
    try { await postSlack([], true); await log('slack', 'test', 'test alert'); }
    catch (e) { await log('slack', 'test', 'test alert', e); throw Object.assign(e, { status: 400 }); }
  } else if (channel === 'email') {
    if (!emailOn()) throw Object.assign(new Error('Email is not configured: enter the Gmail address, app password and recipients on the Alerts page and save'), { status: 400 });
    try { await sendEmail([], true); await log('email', 'test', 'test alert'); }
    catch (e) { await log('email', 'test', 'test alert', e); throw Object.assign(e, { status: 400 }); }
  } else throw Object.assign(new Error('unknown channel'), { status: 400 });
}

// configuration as shown in the UI: never the webhook token or the password
async function status() {
  await ensure();
  const mask = (u) => u.replace(/^(.{3}).*(@.*)$/, '$1…$2');
  return {
    name: conf.name,
    slack: { configured: slackOn(), invalid: !!conf.slack && !slackOn(), mention: conf.slackMention },
    email: { configured: emailOn(), from: conf.gmailUser, passSet: !!conf.gmailPass, to: conf.to, fromMasked: conf.gmailUser ? mask(conf.gmailUser) : '',
      missing: [!conf.gmailUser && 'Gmail address', !conf.gmailPass && 'app password', !conf.to.length && 'recipients'].filter(Boolean) },
    rules: { warningsEmail: conf.warningsEmail, remindMin: conf.remindMin, resolved: conf.resolved },
    source: { ...source },
    types: TYPES.map((t) => ({ ...t, route: routeOf({ key: t.type, severity: t.severity }), custom: ROUTES.includes(conf.routes[t.type]) })),
  };
}

// Save from the Alerts page. Blank webhook / password = keep the saved one; clear: ['slack'|'email'] removes them.
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const bad = (m) => Object.assign(new Error(m), { status: 400 });
async function save(b) {
  await ensure();
  const row = (await q('SELECT * FROM alert_settings WHERE id=1')).rows[0] || {};
  const v = { ...Object.fromEntries(Object.values(COLS).map((c) => [c, row[c] ?? null])), routes: row.routes || {} };
  const clear = Array.isArray(b.clear) ? b.clear : [];
  if (b.slack !== undefined) {
    const w = String(b.slack.webhook || '').trim();
    if (w) { if (!SLACK_RE.test(w)) throw bad('Slack webhook must look like https://hooks.slack.com/services/T…/B…/…'); v.slack_webhook = w; }
    if (b.slack.mention !== undefined) v.slack_mention = !!b.slack.mention;
  }
  if (clear.includes('slack')) v.slack_webhook = '';
  if (b.email !== undefined) {
    const u = String(b.email.user || '').trim(), p = String(b.email.pass || '').replace(/\s+/g, '');
    const to = String(b.email.to || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (u && !EMAIL_RE.test(u)) throw bad('Gmail address is not valid');
    if (p && !/^[a-zA-Z]{16}$/.test(p)) throw bad('App password must be the 16 letters Google shows (spaces are fine)');
    for (const t of to) if (!EMAIL_RE.test(t)) throw bad(`recipient ${t} is not an email address`);
    if (u) v.gmail_user = u;
    if (p) v.gmail_pass = p;
    if (b.email.to !== undefined) v.email_to = to.join(',');
  }
  if (clear.includes('email')) { v.gmail_user = ''; v.gmail_pass = ''; v.email_to = ''; }
  if (b.rules !== undefined) {
    const r = b.rules;
    if (r.remindMin !== undefined) {
      const n = Number(r.remindMin);
      if (!Number.isInteger(n) || n < 0 || n > 1440) throw bad('reminder must be 0–1440 minutes');
      v.remind_min = n;
    }
    if (r.resolved !== undefined) v.resolved = !!r.resolved;
    if (r.name !== undefined) v.name = String(r.name).trim().slice(0, 60) || null;
    if (r.routes !== undefined) {
      const routes = {};
      for (const [t, x] of Object.entries(r.routes || {})) {
        if (!SEVERITY[t]) throw bad(`unknown alert type ${t}`);
        if (!ROUTES.includes(x)) throw bad(`route for ${t} must be one of ${ROUTES.join(', ')}`);
        if (x !== defaultRoute(SEVERITY[t])) routes[t] = x;   // only store changes from the default
      }
      v.routes = routes;
    }
  }
  const cols = [...Object.values(COLS), 'routes'];
  await q(`INSERT INTO alert_settings(id, ${cols.join(',')}, updated_at) VALUES(1, ${cols.map((_, i) => `$${i + 1}`).join(',')}, now())
    ON CONFLICT (id) DO UPDATE SET ${cols.map((c) => `${c}=EXCLUDED.${c}`).join(',')}, updated_at=now()`,
    cols.map((c) => (c === 'routes' ? JSON.stringify(v.routes) : v[c])));
  await reload();
  return status();
}

async function recent(limit = 30) {
  return (await q('SELECT * FROM alert_log ORDER BY at DESC LIMIT $1', [limit])).rows;
}

const enabled = () => slackOn() || emailOn();
// tests: replace the mail transport (e.g. nodemailer jsonTransport) and the alert_log writer
const _set = (o) => { if (o.transport) mailer = o.transport; if (o.q) { dbq = o.q; ready = null; } };
module.exports = { notify, test, status, save, reload, recent, enabled, conf, lines, routeOf, TYPES, _set };
