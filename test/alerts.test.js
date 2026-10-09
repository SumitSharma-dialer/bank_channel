'use strict';
const test = require('node:test');
const assert = require('node:assert');
const alerts = require('../src/diag/alerts');

const logged = [];
alerts._set({ q: async (sql, args) => { logged.push(args); return { rows: [] }; } });
const mails = [];
alerts._set({ transport: { sendMail: async (m) => { mails.push(m); } } });
const slack = [];
global.fetch = async (url, o) => { slack.push({ url, body: JSON.parse(o.body) }); return { ok: true, text: async () => 'ok' }; };

const crit = { key: 'sip_down:test', severity: 'critical', title: 'SIP DOWN: trunk test', detail: 'Endpoint t_test is offline', hint: 'Check firewall', opened_at: new Date(Date.now() - 12 * 60e3) };
const warn = { key: 'limit:tp', severity: 'warning', title: 'LIMIT_REACH on process tp', detail: '3 calls rejected', hint: 'Raise the limit', opened_at: new Date() };

test('not configured: nothing is sent', async () => {
  Object.assign(alerts.conf, { slack: '', gmailUser: '', gmailPass: '', to: [] });
  await alerts.notify([{ kind: 'opened', issue: crit }]);
  assert.strictEqual(slack.length + mails.length, 0);
  assert.strictEqual(alerts.enabled(), false);
  await assert.rejects(alerts.test('slack'), /not configured/);
});

test('one grouped message: Slack gets warnings too, email only critical by default', async () => {
  Object.assign(alerts.conf, { slack: 'https://hooks.slack.com/services/T1/B2/abc', gmailUser: 'alerts@gmail.com', gmailPass: 'abcdefghijklmnop',
    to: ['noc@example.com', 'ops@example.com'], warningsEmail: false, resolved: true, name: 'SIPDist test' });
  slack.length = 0; mails.length = 0; logged.length = 0;
  await alerts.notify([{ kind: 'opened', issue: crit }, { kind: 'opened', issue: warn }]);
  assert.strictEqual(slack.length, 1);
  assert.match(slack[0].body.text, /:red_circle: \*CRITICAL: SIP DOWN: trunk test\*/);
  assert.match(slack[0].body.text, /:warning: \*WARNING: LIMIT_REACH on process tp\*/);
  assert.match(slack[0].body.text, /_→ Check firewall_/);
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].subject, '[SIPDist test] CRITICAL: SIP DOWN: trunk test');
  assert.strictEqual(mails[0].to, 'noc@example.com, ops@example.com');
  assert.doesNotMatch(mails[0].text, /LIMIT_REACH/);
  assert.deepStrictEqual(logged.map((a) => [a[0], a[3]]), [['slack', true], ['email', true]]);
});

test('warnings-only events: no email unless ALERT_WARNINGS_EMAIL', async () => {
  slack.length = 0; mails.length = 0;
  await alerts.notify([{ kind: 'opened', issue: warn }]);
  assert.strictEqual(slack.length, 1); assert.strictEqual(mails.length, 0);
  alerts.conf.warningsEmail = true;
  await alerts.notify([{ kind: 'opened', issue: warn }]);
  assert.strictEqual(mails.length, 1);
  alerts.conf.warningsEmail = false;
});

test('resolved and reminder wording; resolved can be switched off', async () => {
  slack.length = 0; mails.length = 0;
  await alerts.notify([{ kind: 'closed', issue: { ...crit, closed_at: new Date() } }, { kind: 'reminder', issue: crit }]);
  assert.match(slack[0].body.text, /:large_green_circle: \*RESOLVED: SIP DOWN: trunk test \(lasted 12m\)\*/);
  assert.match(slack[0].body.text, /:rotating_light: \*STILL OPEN: SIP DOWN: trunk test \(open 12m\)\*/);
  assert.match(mails[0].subject, /STILL OPEN: SIP DOWN: trunk test \(open 12m\) \(\+1 more\)/);
  alerts.conf.resolved = false; slack.length = 0;
  await alerts.notify([{ kind: 'closed', issue: { ...crit, closed_at: new Date() } }]);
  assert.strictEqual(slack.length, 0);
  alerts.conf.resolved = true;
});

test('failures are logged, never thrown; status hides secrets', async () => {
  global.fetch = async () => ({ ok: false, status: 404, text: async () => 'no_service' });
  alerts._set({ transport: { sendMail: async () => { throw new Error('535 Username and Password not accepted'); } } });
  logged.length = 0;
  await alerts.notify([{ kind: 'opened', issue: crit }]);
  assert.deepStrictEqual(logged.map((a) => [a[0], a[3], a[4]]), [['slack', false, 'Slack 404 no_service'], ['email', false, '535 Username and Password not accepted']]);
  const st = JSON.stringify(await alerts.status());
  assert.ok(!st.includes('abcdefghijklmnop') && !st.includes('services/T1'));
  assert.match(st, /"fromMasked":"ale…@gmail.com"/);
});

test('per-type routes from the Alerts page; @channel mention on critical', async () => {
  const sent = []; global.fetch = async (url, o) => { sent.push(JSON.parse(o.body)); return { ok: true, text: async () => 'ok' }; };
  const ms = []; alerts._set({ transport: { sendMail: async (m) => { ms.push(m); } } });
  Object.assign(alerts.conf, { routes: { sip_down: 'email', limit: 'off' }, slackMention: true });
  assert.strictEqual(alerts.routeOf(crit), 'email');
  assert.strictEqual(alerts.routeOf({ key: 'failrate:x', severity: 'critical' }), 'both');
  await alerts.notify([{ kind: 'opened', issue: crit }, { kind: 'opened', issue: warn }]);
  assert.strictEqual(sent.length, 0);   // sip_down -> email only, limit -> off
  assert.strictEqual(ms.length, 1); assert.match(ms[0].subject, /SIP DOWN/);
  await alerts.notify([{ kind: 'opened', issue: { ...crit, key: 'failrate:x', title: 'High failure rate on trunk x' } }]);
  assert.match(sent[0].text, /^<!channel> \*SIPDist test\*/);
  Object.assign(alerts.conf, { routes: {}, slackMention: false });
});

test('save validates input and keeps saved secrets when left blank', async () => {
  let row = {};
  alerts._set({ q: async (sql, args) => {
    if (/^SELECT \* FROM alert_settings/.test(sql)) return { rows: [row] };
    if (/^INSERT INTO alert_settings/.test(sql)) {
      const cols = sql.match(/alert_settings\(id, ([^)]+)\)/)[1].split(',');
      row = Object.fromEntries(cols.slice(0, -1).map((c, i) => [c, c === 'routes' ? JSON.parse(args[i]) : args[i]]));
    }
    return { rows: [] };
  } });
  await assert.rejects(alerts.save({ slack: { webhook: 'https://example.com/x' } }), /hooks\.slack\.com/);
  await assert.rejects(alerts.save({ email: { pass: 'short' } }), /16 letters/);
  await assert.rejects(alerts.save({ rules: { routes: { nope: 'both' } } }), /unknown alert type/);
  let st = await alerts.save({ slack: { webhook: 'https://hooks.slack.com/services/T9/B9/xyz', mention: true },
    email: { user: 'a@gmail.com', pass: 'abcd efgh ijkl mnop', to: 'x@y.com, z@y.com' }, rules: { remindMin: 15, routes: { lowasr: 'off', sip_down: 'both' } } });
  assert.ok(st.slack.configured && st.slack.mention && st.email.configured);
  assert.deepStrictEqual(row.routes, { lowasr: 'off' });   // sip_down 'both' is the default: not stored
  assert.strictEqual(alerts.conf.remindMin, 15);
  st = await alerts.save({ email: { user: '', pass: '', to: 'x@y.com' } });   // blank = keep
  assert.strictEqual(row.gmail_pass, 'abcdefghijklmnop'); assert.ok(st.email.configured);
  st = await alerts.save({ clear: ['slack'] });
  assert.ok(!st.slack.configured);
});
