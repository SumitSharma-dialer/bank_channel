'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { disposition, setRules, DEFAULT_RULES } = require('../src/disposition');

test('hangup cause refines unanswered DIALSTATUS', () => {
  assert.strictEqual(disposition('CANCEL', '19'), 'NO_ANSWER', 'customer gave up while ringing');
  assert.strictEqual(disposition('CANCEL', '16'), 'CANCEL', 'normal clearing by the customer stays CANCEL');
  assert.strictEqual(disposition('CONGESTION', '17'), 'BUSY');
  assert.strictEqual(disposition('NOANSWER', '20'), 'NO_ANSWER');
  assert.strictEqual(disposition('CONGESTION', '28'), 'FAILED');
  assert.strictEqual(disposition('BUSY', '21'), 'BUSY');
  assert.strictEqual(disposition('CANCEL', '127'), 'CANCEL', 'unlisted cause keeps DIALSTATUS');
  assert.strictEqual(disposition('CONGESTION', '31'), 'CANCEL');
  assert.strictEqual(disposition('CHANUNAVAIL', '31'), 'CANCEL', 'carrier 480 + cause 31 is a cancel');
});

test('cause never overrides answered, SIP_DOWN or our own codes', () => {
  assert.strictEqual(disposition('ANSWER', '19'), 'ANSWERED');
  assert.strictEqual(disposition('CHANUNAVAIL', '20'), 'SIP_DOWN', 'only cause 31 turns CHANUNAVAIL into CANCEL');
  assert.strictEqual(disposition('NO_ROUTE', '34'), 'NO_ROUTE');
  assert.strictEqual(disposition('CHANNEL_LIMIT', '34'), 'CHANNEL_LIMIT');
});

test('edited rules: exact status beats ANY, removed rule falls back to DIALSTATUS', () => {
  setRules([{ cause: 19, status: 'ANY', disposition: 'NO_ANSWER' }, { cause: 19, status: 'CANCEL', disposition: 'CANCEL' },
    { cause: 20, status: 'CHANUNAVAIL', disposition: 'NO_ANSWER' }]);
  assert.strictEqual(disposition('CANCEL', '19'), 'CANCEL');
  assert.strictEqual(disposition('NOANSWER', '19'), 'NO_ANSWER');
  assert.strictEqual(disposition('CHANUNAVAIL', '20'), 'NO_ANSWER', 'a rule may name CHANUNAVAIL');
  assert.strictEqual(disposition('CHANUNAVAIL', '19'), 'SIP_DOWN', 'ANY never covers CHANUNAVAIL');
  assert.strictEqual(disposition('BUSY', '17'), 'BUSY', 'no rule = DIALSTATUS');
  assert.strictEqual(disposition('ANSWER', '19'), 'ANSWERED');
  setRules(DEFAULT_RULES);
});

test('schema seed of cause_rules equals DEFAULT_RULES', () => {
  const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const block = sql.slice(sql.indexOf('INSERT INTO cause_rules'), sql.indexOf('END IF;', sql.indexOf('INSERT INTO cause_rules')));
  const seed = [...block.matchAll(/\((\d+),'(\w+)','(\w+)'\)/g)].map((m) => `${m[1]}:${m[2]}:${m[3]}`).sort();
  assert.deepStrictEqual(seed, DEFAULT_RULES.map((r) => `${r.cause}:${r.status}:${r.disposition}`).sort());
});
