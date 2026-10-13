'use strict';
// Kamailio call events (pushed by sipdist.lua) -> the fields Asterisk's SIPDIST_END user event has, so both engines
// are stored and reported the same way (src/tracker.js saveCall, Dispositions page rules). Pure, unit tested.
const { SIP_CAUSE } = require('../asterisk/render');

// SIP final response -> Q.850 cause, the way chan_pjsip reports it; app_dial then says BUSY / CONGESTION / CHANUNAVAIL
const SIP_Q850 = { 401: 21, 403: 21, 407: 21, 603: 21, 404: 1, 485: 1, 604: 1, 408: 18, 410: 22, 480: 20, 484: 28, 486: 17, 600: 17,
  488: 58, 606: 58, 500: 38, 502: 38, 503: 34, 504: 102 };
// Kamailio 'end' event -> the fields of Asterisk's SIPDIST_END user event (saveCall)
function kamCall(ev) {
  const u = { uid: ev.id, linked: ev.id, proc: ev.proc, trunk: ev.trunk, num: ev.num, out: ev.out, cli: ev.cli, cliout: ev.cliout,
    src: ev.src, dir: ev.dir, did: ev.did, hst: ev.hst, hdid: ev.hdid, hnum: ev.hnum, start: ev.start, end: ev.end, bill: 0,
    dialed: ev.out ? Math.max(0, (+ev.end || 0) - (+ev.start || 0)) : 0 };
  if (ev.disp) return { ...u, disp: ev.disp, dialstatus: '', cause: SIP_CAUSE[ev.sip] || 0 };        // refused by the distributor
  if (ev.res === 'answer') return { ...u, disp: 'ANSWER', dialstatus: 'ANSWER', cause: 16, bill: Math.max(0, (+ev.end || 0) - (+ev.ans || +ev.end || 0)) };
  if (ev.res === 'cancel') return { ...u, disp: 'CANCEL', dialstatus: 'CANCEL', cause: ev.ring ? 19 : 16 };   // caller gave up
  if (ev.res === 'timeout') return { ...u, disp: 'NOANSWER', dialstatus: 'NOANSWER', cause: 19 };             // rang until the dial timeout
  if (ev.res === 'noreply') return { ...u, disp: 'CHANUNAVAIL', dialstatus: 'CHANUNAVAIL', cause: 3 };        // far end does not answer SIP
  const cause = SIP_Q850[ev.sip] || 31;
  const st = cause === 17 ? 'BUSY' : cause === 34 ? 'CONGESTION' : 'CHANUNAVAIL';
  return { ...u, disp: st, dialstatus: st, cause };
}

module.exports = { kamCall, SIP_Q850 };
