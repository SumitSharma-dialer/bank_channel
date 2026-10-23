'use strict';
// Test call from the SIP trunks page: one call straight out of a trunk (Asterisk only), dialed by the [sd-testcall]
// dialplan (src/asterisk/render.js) through Local/<id>-<trunk>-<number>-<cli>@sd-testcall/n. Answered = echo for up to
// 30 s (you hear yourself: audio works both ways). The dialplan reports back with UserEvent SIPDIST_TEST: first the
// trunk leg's channel id (its state is polled: Ringing / Up), then the result — DIALSTATUS and the carrier's SIP reply.
// Not written to the CDR: it is not a customer call.
const ari = require('./ari');
const engine = require('./engine');

const RING_SEC = 45;
const KEEP_MS = 15 * 60e3;   // finished tests stay readable this long
const MAX_LIVE = 3;
const tests = new Map();     // id -> test
const last10 = (v) => String(v || '').replace(/[^0-9]/g, '').slice(-10);
const bad = (m) => Object.assign(new Error(m), { status: 400 });
let seq = 0;

const STATE_TXT = { Down: 'dialing', Ring: 'dialing', Ringing: 'ringing (180)', Up: 'answered — echo test, say something' };

function log(t, msg) { t.events.push({ at: Date.now(), msg }); }

function view(t) {
  const { id, trunk, number, cli, state, startedAt, answeredAt, endedAt, events, result } = t;
  return { id, trunk, number, cli, state, startedAt, answeredAt, endedAt, events, result };
}

function finish(t, result, msg) {
  if (t.endedAt) return;
  clearInterval(t.poll); clearTimeout(t.guard);
  t.endedAt = Date.now();
  t.state = 'ended';
  t.result = result;
  log(t, msg);
}

// state of the trunk leg, once the dialplan has told us its id
async function pollLeg(t) {
  try {
    const ch = await ari.get(`/channels/${encodeURIComponent(t.leg)}`);
    if (ch.state !== t.legState) {
      t.legState = ch.state;
      if (ch.state === 'Up' && !t.answeredAt) { t.answeredAt = Date.now(); t.state = 'answered'; }
      else if (ch.state === 'Ringing') t.state = 'ringing';
      log(t, STATE_TXT[ch.state] || ch.state);
    }
  } catch (e) {
    if (e.status === 404) clearInterval(t.poll);   // leg gone: the result event follows
  }
}

function onUserEvent(e) {
  if (e.eventname !== 'SIPDIST_TEST') return;
  const u = e.userevent || {};
  const t = tests.get(String(u.id || ''));
  if (!t || t.endedAt) return;
  if (u.leg && !t.leg) {
    t.leg = u.leg;
    log(t, `INVITE sent to ${t.trunk}`);
    t.poll = setInterval(() => pollLeg(t), 1000);
  }
  if (u.end) {
    const dialstatus = u.dialstatus || 'FAILED';
    const answered = dialstatus === 'ANSWER' || !!t.answeredAt;
    const result = { ok: answered, dialstatus, sip: u.tech || '', cause: u.cause || '', billSec: +u.bill || 0 };
    finish(t, result, answered ? `call ended after ${result.billSec} s of talk`
      : `not answered: ${dialstatus}${result.sip ? ` · carrier replied ${result.sip}` : ''}${result.cause ? ` · cause ${result.cause}` : ''}`);
  }
}

// the originated channel is gone without a result event (e.g. Local channel could not start)
function onDestroyed(e) {
  const id = String(e.channel && e.channel.id || '');
  if (!id.startsWith('sdtest-')) return;
  const t = tests.get(id.slice(7));
  if (!t || t.endedAt) return;
  setTimeout(() => finish(t, { ok: !!t.answeredAt, dialstatus: t.answeredAt ? 'ANSWER' : 'FAILED', sip: '', cause: e.cause_txt || '', billSec: 0 },
    `call ended (${e.cause_txt || 'no result from the dialplan'})`), 2000);
}

ari.events.on('ChannelUserevent', onUserEvent);
ari.events.on('ChannelDestroyed', onDestroyed);

function gc() {
  for (const [id, t] of tests) if (t.endedAt && Date.now() - t.endedAt > KEEP_MS) tests.delete(id);
}

// trunk: trunks row. number / did as typed; formatted like a live call: last 10 digits, then the trunk's
// prefix / strip_digits on the number and cli_prefix on the DID.
async function start(trunk, number, did) {
  gc();
  if (engine.name() !== 'asterisk') throw bad('test calls need Asterisk as the SIP engine');
  if (!ari.connected) throw bad('Asterisk (ARI) is not connected');
  if (!trunk.active) throw bad(`trunk ${trunk.name} is inactive`);
  if (last10(number).length < 10) throw bad('number to call needs at least 10 digits');
  if (last10(did).length < 4) throw bad('caller ID (DID) needs at least 4 digits');
  if ([...tests.values()].filter((t) => !t.endedAt).length >= MAX_LIVE) throw bad(`at most ${MAX_LIVE} test calls at a time`);
  const out = (trunk.prefix || '') + last10(number).slice(+trunk.strip_digits || 0);
  const cli = (trunk.cli_prefix || '') + last10(did);
  const id = `${Date.now().toString(36)}${(seq++ % 100).toString().padStart(2, '0')}`;
  const t = { id, trunk: trunk.name, number: out, cli, state: 'dialing', startedAt: Date.now(), answeredAt: null, endedAt: null, events: [], result: null };
  tests.set(id, t);
  log(t, `calling ${out} from ${cli} via ${trunk.name} (rings up to ${RING_SEC} s)`);
  const qs = new URLSearchParams({
    endpoint: `Local/${id}-${trunk.name}-${out}-${cli}@sd-testcall/n`,
    context: 'sd-testcall', extension: 'echo', priority: '1',
    timeout: String(RING_SEC + 10), channelId: `sdtest-${id}`,
  });
  try { await ari.post(`/channels?${qs}`); }
  catch (e) { finish(t, { ok: false, dialstatus: 'FAILED', sip: '', cause: '', billSec: 0 }, `could not start: ${e.message}`); }
  // never leave a test hanging: ring time + 30 s echo + margin
  t.guard = setTimeout(() => { hangup(id).catch(() => {}); finish(t, { ok: !!t.answeredAt, dialstatus: 'TIMEOUT', sip: '', cause: '', billSec: 0 }, 'no result in time — hung up'); },
    (RING_SEC + 60) * 1000);
  return view(t);
}

function get(id) {
  const t = tests.get(String(id));
  return t ? view(t) : null;
}

async function hangup(id) {
  const t = tests.get(String(id));
  if (!t) return null;
  if (!t.endedAt) {
    log(t, 'hang up requested');
    try { await ari.del(`/channels/sdtest-${encodeURIComponent(t.id)}`); } catch (e) { if (e.status !== 404) throw e; }
  }
  return view(t);
}

module.exports = { start, get, hangup, _onUserEvent: onUserEvent, _tests: tests };
