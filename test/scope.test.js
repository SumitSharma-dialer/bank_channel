'use strict';
const test = require('node:test');
const assert = require('node:assert');
const scope = require('../src/scope');

const viewer = { role: 'viewer', processes: ['tp'], tabs: ['live', 'cdr'] };
const admin = { role: 'admin', processes: [], tabs: [] };
const run = (a, method, path) => { let code = 200; scope.guard({ auth: a, method, path }, { status: (c) => { code = c; return { json: () => {} }; } }, () => {}); return code; };

test('viewer: only GET routes of their tabs; admin passes', () => {
  assert.strictEqual(run(viewer, 'GET', '/live'), 200);
  assert.strictEqual(run(viewer, 'GET', '/reports/calls'), 200);
  assert.strictEqual(run(viewer, 'GET', '/reports/calls.csv'), 200);
  assert.strictEqual(run(viewer, 'GET', '/reports/daily'), 403);   // stats tab not given
  assert.strictEqual(run(viewer, 'GET', '/processes'), 403);
  assert.strictEqual(run(viewer, 'POST', '/processes'), 403);
  assert.strictEqual(run(viewer, 'GET', '/users'), 403);
  assert.strictEqual(run(viewer, 'POST', '/me/password'), 200);
  assert.strictEqual(run(admin, 'DELETE', '/trunks/1'), 200);
});

test('viewer snapshot: own processes, no trunks, totals recomputed', () => {
  const s = { at: 1, ariConnected: true, live: 50, processCapacity: 100, trunkCapacity: 200, peakToday: 60, hitsMin: 9, hitsToday: 99,
    processes: [{ code: 'tp', active: true, limit: 10, live: 3, peak: 5, hitsMin: 2, hitsToday: 20, trunk: 'airtel' },
      { code: 'other', active: true, limit: 90, live: 47, peak: 55, hitsMin: 7, hitsToday: 79, trunk: 'jio' }],
    trunks: [{ name: 'airtel' }], issues: { critical: 1, warning: 0 } };
  const v = scope.snapshot(s, viewer);
  assert.deepStrictEqual(v.processes.map((p) => p.code), ['tp']);
  assert.strictEqual(v.processes[0].trunk, '');
  assert.deepStrictEqual(v.trunks, []);
  assert.strictEqual(v.live, 3); assert.strictEqual(v.processCapacity, 10); assert.strictEqual(v.hitsToday, 20);
  assert.strictEqual(v.issues, undefined);
  assert.strictEqual(scope.snapshot(s, admin), s);
  assert.ok(scope.seesProcess(viewer, 'tp') && !scope.seesProcess(viewer, 'other') && scope.seesProcess(admin, 'other'));
});
