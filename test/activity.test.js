'use strict';
const test = require('node:test');
const assert = require('node:assert');
const auth = require('../src/auth');
const activity = require('../src/activity');

test('roles: super admin and admin pass requireAdmin, only super admin passes requireSuper', () => {
  const run = (mw, role) => { let ok = false, code = 200; mw({ auth: { role } }, { status: (c) => { code = c; return { json: () => {} }; } }, () => { ok = true; }); return ok ? 200 : code; };
  assert.strictEqual(run(auth.requireAdmin, 'superadmin'), 200);
  assert.strictEqual(run(auth.requireAdmin, 'admin'), 200);
  assert.strictEqual(run(auth.requireAdmin, 'viewer'), 403);
  assert.strictEqual(run(auth.requireSuper, 'superadmin'), 200);
  assert.strictEqual(run(auth.requireSuper, 'admin'), 403);
  assert.strictEqual(run(auth.requireSuper, 'viewer'), 403);
});

test('activity: readable action names and query without secrets', () => {
  assert.strictEqual(activity.nameOf('GET', '/reports/calls.csv'), 'Exported CDR CSV');
  assert.strictEqual(activity.nameOf('PUT', '/trunks/4'), 'Edited trunk');
  assert.strictEqual(activity.nameOf('DELETE', '/users/sessions/9'), 'Signed out a session');
  assert.strictEqual(activity.nameOf('GET', '/nothing'), null);
  assert.strictEqual(activity.cleanQuery('/reports/calls?from=2026-10-01&token=abc'), 'from=2026-10-01&token=***');
  assert.strictEqual(activity.cleanQuery('/live'), null);
});

test('activity detail: filters viewed and fields changed, in words', () => {
  assert.strictEqual(activity.viewDetail('from=2026-10-01&to=2026-10-09&process=tp&disposition=&number=98&page=2&size=50'),
    '2026-10-01 → 2026-10-09 · process tp · number contains 98 · page 2');
  assert.strictEqual(activity.viewDetail('from=2026-10-09&to=2026-10-09'), '2026-10-09');
  assert.strictEqual(activity.changeDetail({ entity: 'trunk', entityId: 3, details: { name: 'airtel', changes: { max_channels: [30, 60], password: ['***', '*** (changed)'] } } }),
    'trunk airtel: max channels 30 → 60, password *** → *** (changed)');
  assert.strictEqual(activity.changeDetail({ entity: 'process', entityId: 7, details: { code: 'tp' } }), 'process tp');
});
