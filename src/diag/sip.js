'use strict';
// SIP message parsing + an in-memory dialog store grouped by Call-ID (what sngrep shows). Pure, no I/O.

const COMPACT = { i: 'call-id', f: 'from', t: 'to', v: 'via', m: 'contact', l: 'content-length', c: 'content-type', k: 'supported' };
const START_RE = /^(?:([A-Z]+) (\S+) SIP\/2\.0|SIP\/2\.0 (\d{3}) ?(.*))$/;
const RAW_MAX = 8192;

// "Name" <sip:user@host;x>;tag=abc  ->  { user, tag }
function nameAddr(v) {
  const s = String(v || '');
  const m = /sips?:([^@;>]+)@/i.exec(s) || /tel:([^;>]+)/i.exec(s) || /sips?:([^;>]+)/i.exec(s);
  const t = /;\s*tag=([^;,\s]+)/i.exec(s.replace(/<[^>]*>/, ''));
  return { user: m ? m[1] : s.slice(0, 40), tag: t ? t[1] : '' };
}

// Buffer/string -> parsed message, or null when it is not SIP
function parse(text) {
  const s = Buffer.isBuffer(text) ? text.toString('latin1') : String(text);
  const end = s.indexOf('\r\n\r\n');
  const head = end < 0 ? s : s.slice(0, end);
  const lines = head.split(/\r?\n/);
  const sm = START_RE.exec(lines[0]);
  if (!sm) return null;
  const h = {};
  for (let i = 1; i < lines.length; i++) {
    let l = lines[i];
    while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) l += ' ' + lines[++i].trim();   // folded header
    const c = l.indexOf(':'); if (c < 1) continue;
    let k = l.slice(0, c).trim().toLowerCase(); k = COMPACT[k] || k;
    if (!(k in h)) h[k] = l.slice(c + 1).trim();
  }
  const cseq = /^(\d+)\s+(\S+)/.exec(h.cseq || '') || [];
  const body = end < 0 ? '' : s.slice(end + 4);
  const msg = {
    request: !!sm[1], method: sm[1] || cseq[2] || '', uri: sm[2] || '', code: sm[3] ? +sm[3] : 0, reason: sm[4] || '',
    callId: h['call-id'] || '', cseq: cseq[1] ? +cseq[1] : 0, cseqMethod: cseq[2] || '',
    from: nameAddr(h.from), to: nameAddr(h.to), ua: h['user-agent'] || h.server || '',
    reasonHdr: h.reason || '', xdid: h['x-did'] || '', xnum: h['x-number'] || '',
    sdp: /application\/sdp/i.test(h['content-type'] || '') ? sdp(body) : null,
    raw: s.length > RAW_MAX ? s.slice(0, RAW_MAX) + '\n…(truncated)' : s,
  };
  return msg.callId ? msg : null;
}

// c= address, audio port and codec names from an SDP body
function sdp(body) {
  const c = /^c=IN IP[46] (\S+)/m.exec(body), m = /^m=audio (\d+) \S+ ([\d ]+)/m.exec(body);
  const names = {}; for (const r of body.matchAll(/^a=rtpmap:(\d+) ([^/\s]+)/gm)) names[r[1]] = r[2];
  const STATIC = { 0: 'PCMU', 3: 'GSM', 8: 'PCMA', 9: 'G722', 18: 'G729' };
  const dir = /^a=(sendrecv|sendonly|recvonly|inactive)/m.exec(body);
  return { ip: c ? c[1] : '', port: m ? +m[1] : 0,
    codecs: m ? m[2].trim().split(/\s+/).map((pt) => names[pt] || STATIC[pt] || pt) : [], dir: dir ? dir[1] : 'sendrecv' };
}

// TCP: split a byte stream into whole SIP messages using Content-Length. Returns { msgs: [Buffer], rest: Buffer }.
function splitStream(buf) {
  const msgs = [];
  for (;;) {
    while (buf.length >= 2 && buf[0] === 13 && buf[1] === 10) buf = buf.subarray(2);   // keep-alive CRLFs
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) break;
    const head = buf.subarray(0, end).toString('latin1');
    const cl = /^(?:content-length|l)\s*:\s*(\d+)/im.exec(head);
    const total = end + 4 + (cl ? +cl[1] : 0);
    if (buf.length < total) break;
    msgs.push(buf.subarray(0, total));
    buf = buf.subarray(total);
  }
  return { msgs, rest: buf.length > 65536 ? Buffer.alloc(0) : buf };
}

// ------------------------------------------------------------------ dialog store
const NOISE = new Set(['OPTIONS', 'REGISTER', 'NOTIFY', 'SUBSCRIBE', 'PUBLISH']);

class DialogStore {
  constructor({ maxDialogs = 2000, maxMsgs = 60, keepNoise = false } = {}) {
    this.maxDialogs = maxDialogs; this.maxMsgs = maxMsgs; this.keepNoise = keepNoise;
    this.d = new Map(); this.seq = 0;
  }

  clear() { this.d.clear(); }

  // pkt from PcapReader, msg from parse()
  add(pkt, msg) {
    if (!this.keepNoise && NOISE.has(msg.cseqMethod || msg.method)) return null;
    let g = this.d.get(msg.callId);
    if (!g) {
      if (!msg.request) return null;   // response to a request we did not see (capture started mid-dialog)
      g = { callId: msg.callId, method: msg.method, start: pkt.ts, from: msg.from.user, to: msg.to.user,
        src: `${pkt.src}:${pkt.sport}`, dst: `${pkt.dst}:${pkt.dport}`, ua: msg.ua, xdid: msg.xdid, xnum: msg.xnum,
        state: 'CALL SETUP', code: 0, reason: '', msgs: [], records: [], count: 0 };
      this.d.set(msg.callId, g);
      if (this.d.size > this.maxDialogs) this.d.delete(this.d.keys().next().value);
    }
    g.last = pkt.ts; g.count++; g.rev = ++this.seq;
    if (msg.ua && !g.ua) g.ua = msg.ua;
    if (g.msgs.length < this.maxMsgs) {
      g.msgs.push({ ts: pkt.ts, src: `${pkt.src}:${pkt.sport}`, dst: `${pkt.dst}:${pkt.dport}`, proto: pkt.proto,
        label: msg.request ? msg.method : `${msg.code} ${msg.reason}`.trim(), request: msg.request, code: msg.code,
        cseq: `${msg.cseq} ${msg.cseqMethod}`, sdp: msg.sdp, reasonHdr: msg.reasonHdr, raw: msg.raw });
      g.records.push(pkt.record);
    }
    this.state(g, msg);
    return g;
  }

  // sngrep-like call state
  state(g, msg) {
    if (g.method !== 'INVITE') {
      if (!msg.request && msg.code >= 200 && msg.cseqMethod === g.method) { g.state = msg.code < 300 ? 'COMPLETED' : 'REJECTED'; g.code = msg.code; g.reason = msg.reason; }
      return;
    }
    if (msg.request) {
      if (msg.method === 'CANCEL') g.state = 'CANCELLED';
      else if (msg.method === 'BYE') g.state = 'COMPLETED';
      return;
    }
    if (msg.cseqMethod !== 'INVITE') return;
    if (msg.code === 180 || msg.code === 183) { if (g.state === 'CALL SETUP') g.state = 'RINGING'; g.ringAt = g.ringAt || g.last; }
    else if (msg.code >= 200 && msg.code < 300) { if (g.state !== 'COMPLETED') g.state = 'IN CALL'; g.code = msg.code; g.answerAt = g.answerAt || g.last; }
    else if (msg.code >= 300) {
      if (msg.code === 401 || msg.code === 407) { g.challenged = true; return; }   // auth challenge, a new INVITE follows
      if (g.state !== 'CANCELLED') g.state = 'REJECTED';
      g.code = msg.code; g.reason = msg.reason;
    }
  }

  summary(g) {
    const { msgs, records, ...s } = g;
    const sdp = msgs.filter((m) => m.sdp).map((m) => ({ from: m.src, ip: m.sdp.ip, port: m.sdp.port, codecs: m.sdp.codecs.slice(0, 4) }));
    return { ...s, sdp };
  }

  // newest first; q matches Call-ID, From, To, IPs, X-DID / X-Number
  list({ q = '', method = '', limit = 500 } = {}) {
    const needle = String(q).toLowerCase();
    const out = [];
    for (const g of [...this.d.values()].reverse()) {
      if (method && g.method !== method) continue;
      if (needle && ![g.callId, g.from, g.to, g.src, g.dst, g.xdid, g.xnum].some((v) => String(v || '').toLowerCase().includes(needle))) continue;
      out.push(this.summary(g));
      if (out.length >= limit) break;
    }
    return out;
  }

  get(callId) { return this.d.get(callId) || null; }
}

// ------------------------------------------------------------------ live message log
// Every SIP message in arrival order (requests AND responses, REGISTER / OPTIONS included), like sngrep's raw view
// or `tcpdump -A`. A ring buffer; clients poll with ?after=<id>.
const CALL_METHODS = new Set(['INVITE', 'ACK', 'BYE', 'CANCEL', 'PRACK', 'UPDATE', 'INFO', 'REFER']);
function msgType(m) {
  const meth = m.cseqMethod || m.method;
  if (CALL_METHODS.has(meth)) return 'call';
  if (meth === 'REGISTER') return 'register';
  if (meth === 'OPTIONS') return 'options';
  return 'other';
}

class MessageLog {
  constructor(max = 5000) { this.max = max; this.list = []; this.seq = 0; }

  clear() { this.list = []; }

  add(pkt, m) {
    const e = { id: ++this.seq, ts: pkt.ts, src: `${pkt.src}:${pkt.sport}`, dst: `${pkt.dst}:${pkt.dport}`, proto: pkt.proto,
      type: msgType(m), request: m.request, label: m.request ? m.method : `${m.code} ${m.reason}`.trim(), code: m.code,
      method: m.cseqMethod || m.method, cseq: `${m.cseq} ${m.cseqMethod}`, callId: m.callId, from: m.from.user, to: m.to.user,
      ua: m.ua, xdid: m.xdid, xnum: m.xnum, sdp: m.sdp ? `${m.sdp.ip}:${m.sdp.port} ${m.sdp.codecs.slice(0, 3).join('/')}` : '',
      raw: m.raw };
    this.list.push(e);
    if (this.list.length > this.max) this.list.splice(0, this.list.length - this.max);
    return e;
  }

  // messages with id > after; types: Set of call/register/options/other (empty = all); q: text in Call-ID/From/To/IPs/raw
  // hidden (optional object) collects counts per type of messages left out by the type filter
  since(after = 0, { types = null, q = '', limit = 500, hidden = null } = {}) {
    const needle = String(q).toLowerCase();
    const out = [];
    for (let i = this.list.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.list[i];
      if (e.id <= after) break;
      if (types && types.size && !types.has(e.type)) { if (hidden) hidden[e.type] = (hidden[e.type] || 0) + 1; continue; }
      if (needle && ![e.callId, e.from, e.to, e.src, e.dst, e.xnum, e.xdid].some((v) => String(v || '').toLowerCase().includes(needle))
        && !e.raw.toLowerCase().includes(needle)) continue;
      out.push(e);
    }
    return out.reverse();
  }
}

module.exports = { parse, sdp, splitStream, DialogStore, MessageLog, msgType, nameAddr };
