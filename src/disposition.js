'use strict';
// Call disposition from DIALSTATUS / our own SD_DISP code, refined by the Q.850 hangup cause.

// CHANUNAVAIL = the far end could not be reached at all (qualify says unreachable / no contact) -> SIP_DOWN
const DIAL_MAP = { ANSWER: 'ANSWERED', BUSY: 'BUSY', NOANSWER: 'NO_ANSWER', CANCEL: 'CANCEL',
  CONGESTION: 'CONGESTION', CHANUNAVAIL: 'SIP_DOWN', DONTCALL: 'FAILED', TORTURE: 'FAILED', INVALIDARGS: 'FAILED' };
const OWN = new Set(['ANSWERED', 'BUSY', 'NO_ANSWER', 'CANCEL', 'CONGESTION', 'FAILED',
  'CHANNEL_LIMIT', 'TRUNK_LIMIT', 'BLOCKED', 'NO_ROUTE', 'INVALID', 'OFF_HOURS', 'NO_HEADER', 'INVALID_DID', 'SIP_DOWN']);

// Q.850 / ISDN hangup cause -> disposition, for calls that were not answered. DIALSTATUS alone misleads: a
// customer dialer that gives up after ringing sends CANCEL with cause 19, which is a no-answer, not a cancel.
// Not listed (16 normal clearing, 31 unspecified, ...) = keep what DIALSTATUS says.
const CAUSE_MAP = {
  1: 'FAILED',        // unallocated / unassigned number
  3: 'FAILED',        // no route to destination
  17: 'BUSY',         // user busy
  18: 'NO_ANSWER',    // no user responding
  19: 'NO_ANSWER',    // no answer from user (user alerted)
  20: 'NO_ANSWER',    // subscriber absent (switched off / out of coverage)
  21: 'BUSY',         // call rejected (callee declined)
  22: 'FAILED',       // number changed
  27: 'FAILED',       // destination out of order
  28: 'FAILED',       // invalid number format
  34: 'CONGESTION',   // no circuit/channel available
  38: 'CONGESTION',   // network out of order
  41: 'CONGESTION',   // temporary failure
  42: 'CONGESTION',   // switching equipment congestion
  44: 'CONGESTION',   // requested channel not available
  47: 'CONGESTION',   // resource unavailable
  58: 'CONGESTION',   // bearer capability not presently available
  102: 'NO_ANSWER',   // recovery on timer expiry
};
// only these DIALSTATUS results are refined by the cause; CHANUNAVAIL stays SIP_DOWN (trunk problem), ANSWER stays
const BY_CAUSE = new Set(['CANCEL', 'NOANSWER', 'BUSY', 'CONGESTION']);

function disposition(raw, cause) {
  const d = String(raw || '').toUpperCase();
  if (BY_CAUSE.has(d) && CAUSE_MAP[parseInt(cause, 10)]) return CAUSE_MAP[parseInt(cause, 10)];
  if (OWN.has(d)) return d;
  return DIAL_MAP[d] || 'FAILED';
}

module.exports = { disposition, OWN };
