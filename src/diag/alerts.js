'use strict';
// Slack + Gmail alerts for the issue tracker (src/diag/issues.js). Secrets come only from .env:
//   ALERT_SLACK_WEBHOOK        https://hooks.slack.com/services/...
//   ALERT_GMAIL_USER           sender Gmail address
//   ALERT_GMAIL_APP_PASSWORD   16-char Google App Password (needs 2-Step Verification)
//   ALERT_EMAIL_TO             comma-separated recipients
// Optional: ALERT_WARNINGS_EMAIL=1 (warnings by email too; default Slack only), ALERT_REMIND_MIN=30 (0 = off),
//           ALERT_RESOLVED=0 (no "resolved" messages), ALERT_NAME (server name in messages).
const os = require('os');
const cfg = require('../config');
let { q: dbq } = require('../db');
const q = (...a) => dbq(...a);

const env = process.env;
const conf = {
  slack: (env.ALERT_SLACK_WEBHOOK || '').trim(),
  gmailUser: (env.ALERT_GMAIL_USER || '').trim(),
  gmailPass: (env.ALERT_GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),   // Google shows it as "abcd efgh ijkl mnop"
  to: (env.ALERT_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean),
  warningsEmail: env.ALERT_WARNINGS_EMAIL === '1',
  remindMin: Math.max(0, +(env.ALERT_REMIND_MIN ?? 30) || 0),
  resolved: env.ALERT_RESOLVED !== '0',
  name: env.ALERT_NAME || `SIPDist ${cfg.publicIp !== '127.0.0.1' ? cfg.publicIp : os.hostname()}`,
};
const SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/;
const slackOn = () => SLACK_RE.test(conf.slack);
const emailOn = () => !!(conf.gmailUser && conf.gmailPass && conf.to.length);

let mailer = null;
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
    : `*${conf.name}*\n` + ls.map((l) => `${ICON[l.tag]} *${l.title}*${l.detail ? `\n${l.detail}` : ''}${l.hint ? `\n_→ ${l.hint}_` : ''}`).join('\n\n');
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

// Send one grouped message per channel. Warnings go to email only with ALERT_WARNINGS_EMAIL=1.
async function notify(events) {
  if (!conf.resolved) events = events.filter((e) => e.kind !== 'closed');
  if (!events.length) return;
  const kind = events.map((e) => e.kind).sort().filter((k, i, a) => a.indexOf(k) === i).join('+');
  const subject = lines(events).map((l) => l.title).join(' | ');
  if (slackOn()) {
    try { await postSlack(events); await log('slack', kind, subject); }
    catch (e) { console.error('[alert] slack', e.message); await log('slack', kind, subject, e); }
  }
  const forEmail = conf.warningsEmail ? events : events.filter((e) => e.issue.severity === 'critical');
  if (emailOn() && forEmail.length) {
    try { await sendEmail(forEmail); await log('email', kind, subject); }
    catch (e) { console.error('[alert] email', e.message); await log('email', kind, subject, e); }
  }
}

async function test(channel) {
  if (channel === 'slack') {
    if (!slackOn()) throw Object.assign(new Error('Slack is not configured: set ALERT_SLACK_WEBHOOK in .env and restart'), { status: 400 });
    try { await postSlack([], true); await log('slack', 'test', 'test alert'); }
    catch (e) { await log('slack', 'test', 'test alert', e); throw Object.assign(e, { status: 400 }); }
  } else if (channel === 'email') {
    if (!emailOn()) throw Object.assign(new Error('Email is not configured: set ALERT_GMAIL_USER, ALERT_GMAIL_APP_PASSWORD and ALERT_EMAIL_TO in .env and restart'), { status: 400 });
    try { await sendEmail([], true); await log('email', 'test', 'test alert'); }
    catch (e) { await log('email', 'test', 'test alert', e); throw Object.assign(e, { status: 400 }); }
  } else throw Object.assign(new Error('unknown channel'), { status: 400 });
}

// configuration as shown in the UI: never the webhook token or the password
function status() {
  const mask = (u) => u.replace(/^(.{3}).*(@.*)$/, '$1…$2');
  return {
    name: conf.name,
    slack: { configured: slackOn(), invalid: !!conf.slack && !slackOn() },
    email: { configured: emailOn(), from: conf.gmailUser ? mask(conf.gmailUser) : '', to: conf.to.map(mask),
      missing: [!conf.gmailUser && 'ALERT_GMAIL_USER', !conf.gmailPass && 'ALERT_GMAIL_APP_PASSWORD', !conf.to.length && 'ALERT_EMAIL_TO'].filter(Boolean) },
    rules: { warningsEmail: conf.warningsEmail, remindMin: conf.remindMin, resolved: conf.resolved },
  };
}

async function recent(limit = 30) {
  return (await q('SELECT * FROM alert_log ORDER BY at DESC LIMIT $1', [limit])).rows;
}

const enabled = () => slackOn() || emailOn();
// tests: replace the mail transport (e.g. nodemailer jsonTransport) and the alert_log writer
const _set = (o) => { if (o.transport) mailer = o.transport; if (o.q) dbq = o.q; };
module.exports = { notify, test, status, recent, enabled, conf, lines, _set };
