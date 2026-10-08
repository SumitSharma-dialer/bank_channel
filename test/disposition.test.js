'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { disposition } = require('../src/disposition');

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
