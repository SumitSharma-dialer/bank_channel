'use strict';
// Call disposition from DIALSTATUS / our own SD_DISP code, refined by the Q.850 hangup cause.

// CHANUNAVAIL = the far end refused or could not be reached. It is SIP_DOWN only while the trunk itself is down
// (OPTIONS ping gets no reply); otherwise the carrier rejected the call -> REJECTED.
const DIAL_MAP = { ANSWER: 'ANSWERED', BUSY: 'BUSY', NOANSWER: 'NO_ANSWER', CANCEL: 'CANCEL',
  CONGESTION: 'CONGESTION', CHANUNAVAIL: 'REJECTED', DONTCALL: 'FAILED', TORTURE: 'FAILED', INVALIDARGS: 'FAILED' };
const OWN = new Set(['ANSWERED', 'BUSY', 'NO_ANSWER', 'CANCEL', 'CONGESTION', 'FAILED',
  'CHANNEL_LIMIT', 'TRUNK_LIMIT', 'BLOCKED', 'NO_ROUTE', 'INVALID', 'OFF_HOURS', 'NO_HEADER', 'INVALID_DID', 'SIP_DOWN', 'REJECTED']);

// Q.850 / ISDN hangup cause -> disposition, for calls that were not answered. DIALSTATUS alone misleads: a
// customer dialer that gives up after ringing sends CANCEL with cause 19, which is a no-answer, not a cancel.
// Rules are edited on the Dispositions page (table cause_rules); DEFAULT_RULES seed it and apply until it is loaded.
// status = the DIALSTATUS the rule applies to; ANY = any unanswered result except CHANUNAVAIL (kept as REJECTED unless a
// rule names it, SIP_DOWN while the trunk is down). An exact-status rule wins over ANY. No rule = keep what DIALSTATUS says.
const CAUSE_STATUSES = ['ANY', 'CANCEL', 'NOANSWER', 'BUSY', 'CONGESTION', 'CHANUNAVAIL'];
const CAUSE_TARGETS = ['NO_ANSWER', 'BUSY', 'CANCEL', 'CONGESTION', 'FAILED', 'SIP_DOWN'];
const ANY = new Set(['CANCEL', 'NOANSWER', 'BUSY', 'CONGESTION']);
const DEFAULT_RULES = [
  [1, 'FAILED'], [3, 'FAILED'], [17, 'BUSY'], [18, 'NO_ANSWER'], [19, 'NO_ANSWER'], [20, 'NO_ANSWER'], [21, 'BUSY'],
  [22, 'FAILED'], [27, 'FAILED'], [28, 'FAILED'], [31, 'CANCEL'], [34, 'CONGESTION'], [38, 'CONGESTION'],
  [41, 'CONGESTION'], [42, 'CONGESTION'], [44, 'CONGESTION'], [47, 'CONGESTION'], [58, 'CONGESTION'], [102, 'NO_ANSWER'],
].map(([cause, disposition]) => ({ cause, status: 'ANY', disposition }))
  // a carrier reject after ringing (480 + cause 31) comes back as CHANUNAVAIL; it is a cancel, not a dead trunk
  .concat({ cause: 31, status: 'CHANUNAVAIL', disposition: 'CANCEL' });

let rules = new Map();
function setRules(list) {
  rules = new Map(list.map((r) => [`${+r.cause}:${r.status}`, r.disposition]));
}
setRules(DEFAULT_RULES);

// trunkDown: the trunk the call went to does not answer OPTIONS right now
function disposition(raw, cause, trunkDown) {
  const d = String(raw || '').toUpperCase();
  const c = parseInt(cause, 10);
  if (d === 'CHANUNAVAIL' && trunkDown) return 'SIP_DOWN';
  if (c && (ANY.has(d) || d === 'CHANUNAVAIL')) {
    const hit = rules.get(`${c}:${d}`) || (ANY.has(d) && rules.get(`${c}:ANY`));
    if (hit) return hit;
  }
  if (OWN.has(d)) return d;
  return DIAL_MAP[d] || 'FAILED';
}

module.exports = { disposition, setRules, DEFAULT_RULES, CAUSE_STATUSES, CAUSE_TARGETS, OWN };
