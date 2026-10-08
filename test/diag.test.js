'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PcapReader, toPcap } = require('../src/diag/pcap');
const { parse, splitStream, DialogStore, MessageLog } = require('../src/diag/sip');
const { RtpAnalyzer } = require('../src/diag/rtp');

// ---- build a pcap (Linux cooked v2, like `tcpdump -i any`)
function globalHeader(link = 276) {
  const b = Buffer.alloc(24);
  b.writeUInt32LE(0xa1b2c3d4, 0); b.writeUInt16LE(2, 4); b.writeUInt16LE(4, 6); b.writeUInt32LE(262144, 16); b.writeUInt32LE(link, 20);
  return b;
}
function ip4(src, dst, proto, body, { id = 1, off = 0, more = false } = {}) {
  const h = Buffer.alloc(20);
  h[0] = 0x45; h.writeUInt16BE(20 + body.length, 2); h.writeUInt16BE(id, 4);
  h.writeUInt16BE((more ? 0x2000 : 0) | (off / 8), 6); h[8] = 64; h[9] = proto;
  src.split('.').forEach((x, i) => { h[12 + i] = +x; }); dst.split('.').forEach((x, i) => { h[16 + i] = +x; });
  return Buffer.concat([h, body]);
}
function udp(sport, dport, payload) {
  const h = Buffer.alloc(8); h.writeUInt16BE(sport, 0); h.writeUInt16BE(dport, 2); h.writeUInt16BE(8 + payload.length, 4);
  return Buffer.concat([h, payload]);
}
function record(tsMs, ipPacket) {
  const sll = Buffer.alloc(20); sll.writeUInt16BE(0x0800, 0);
  const data = Buffer.concat([sll, ipPacket]);
  const h = Buffer.alloc(16);
  h.writeUInt32LE(Math.floor(tsMs / 1000), 0); h.writeUInt32LE((tsMs % 1000) * 1000, 4); h.writeUInt32LE(data.length, 8); h.writeUInt32LE(data.length, 12);
  return Buffer.concat([h, data]);
}
const sipUdp = (ts, src, dst, text) => record(ts, ip4(src.split(':')[0], dst.split(':')[0], 17, udp(+src.split(':')[1], +dst.split(':')[1], Buffer.from(text))));

const C = '10.0.0.5:5060', D = '172.20.10.201:5060', CID = 'abc123@10.0.0.5';
function req(method, cseq, extra = '', body = '') {
  return `${method} sip:9999@172.20.10.201 SIP/2.0\r\nVia: SIP/2.0/UDP 10.0.0.5\r\nFrom: <sip:1100@10.0.0.5>;tag=f1\r\nTo: <sip:9999@172.20.10.201>\r\n` +
    `Call-ID: ${CID}\r\nCSeq: ${cseq} ${method}\r\nX-DID: 1100\r\nX-Number: 9876543210\r\n${extra}Content-Length: ${body.length}\r\n\r\n${body}`;
}
function resp(code, reason, cseq, method, body = '', ct = '') {
  return `SIP/2.0 ${code} ${reason}\r\nVia: SIP/2.0/UDP 10.0.0.5\r\nf: <sip:1100@10.0.0.5>;tag=f1\r\nt: <sip:9999@172.20.10.201>;tag=t1\r\n` +
    `i: ${CID}\r\nCSeq: ${cseq} ${method}\r\n${ct}Content-Length: ${body.length}\r\n\r\n${body}`;
}
const SDP = 'v=0\r\no=- 1 1 IN IP4 10.0.0.5\r\ns=-\r\nc=IN IP4 10.0.0.5\r\nt=0 0\r\nm=audio 12000 RTP/AVP 8 0 101\r\na=rtpmap:101 telephone-event/8000\r\na=sendrecv\r\n';

function callPcap() {
  return Buffer.concat([globalHeader(),
    sipUdp(1000, C, D, req('INVITE', 1, 'Content-Type: application/sdp\r\n', SDP)),
    sipUdp(1010, D, C, resp(100, 'Trying', 1, 'INVITE')),
    sipUdp(1500, D, C, resp(180, 'Ringing', 1, 'INVITE')),
    sipUdp(4000, D, C, resp(200, 'OK', 1, 'INVITE', SDP, 'c: application/sdp\r\n')),
    sipUdp(4010, C, D, req('ACK', 1)),
    sipUdp(9000, C, D, req('BYE', 2)),
    sipUdp(9010, D, C, resp(200, 'OK', 2, 'BYE')),
    sipUdp(9100, C, D, req('OPTIONS', 3).replace(CID, 'opt@x'))]);
}

test('pcap reader decodes SLL2/IPv4/UDP across arbitrary chunk boundaries', () => {
  const pkts = [];
  const r = new PcapReader((p) => pkts.push(p));
  const buf = callPcap();
  for (let i = 0; i < buf.length; i += 37) r.push(buf.subarray(i, i + 37));
  assert.strictEqual(pkts.length, 8);
  assert.deepStrictEqual([pkts[0].src, pkts[0].sport, pkts[0].dst, pkts[0].dport, pkts[0].proto], ['10.0.0.5', 5060, '172.20.10.201', 5060, 'udp']);
  assert.strictEqual(pkts[1].ts, 1010);
  // records + header rebuild a valid pcap
  const again = [];
  new PcapReader((p) => again.push(p)).push(toPcap(r.header, pkts.map((p) => p.record)));
  assert.strictEqual(again.length, 8);
});

test('pcap reader reassembles fragmented IPv4 UDP', () => {
  const big = Buffer.from(req('INVITE', 1, 'Content-Type: application/sdp\r\n', SDP + 'a=x:' + 'y'.repeat(1600) + '\r\n'));
  const dgram = udp(5060, 5060, big);
  const cut = 1480;
  const pkts = [];
  const r = new PcapReader((p) => pkts.push(p));
  r.push(Buffer.concat([globalHeader(),
    record(1, ip4('10.0.0.5', '172.20.10.201', 17, dgram.subarray(0, cut), { id: 7, more: true })),
    record(2, ip4('10.0.0.5', '172.20.10.201', 17, dgram.subarray(cut), { id: 7, off: cut }))]));
  assert.strictEqual(pkts.length, 1);
  assert.strictEqual(parse(pkts[0].payload).method, 'INVITE');
});

test('SIP parse: request, response with compact headers, SDP', () => {
  const m = parse(req('INVITE', 1, 'Content-Type: application/sdp\r\n', SDP));
  assert.strictEqual(m.method, 'INVITE'); assert.strictEqual(m.callId, CID);
  assert.strictEqual(m.from.user, '1100'); assert.strictEqual(m.to.user, '9999');
  assert.strictEqual(m.xdid, '1100'); assert.strictEqual(m.xnum, '9876543210');
  assert.deepStrictEqual(m.sdp, { ip: '10.0.0.5', port: 12000, codecs: ['PCMA', 'PCMU', 'telephone-event'], dir: 'sendrecv' });
  const r = parse(resp(486, 'Busy Here', 1, 'INVITE'));
  assert.strictEqual(r.code, 486); assert.strictEqual(r.cseqMethod, 'INVITE'); assert.strictEqual(r.to.tag, 't1');
  assert.strictEqual(parse('GET / HTTP/1.1\r\n\r\n'), null);
});

test('TCP stream split by Content-Length', () => {
  const a = req('INVITE', 1, '', 'hello'), b = req('BYE', 2);
  const all = Buffer.from('\r\n\r\n' + a + b);
  const r1 = splitStream(all.subarray(0, 30));
  assert.strictEqual(r1.msgs.length, 0);
  const r2 = splitStream(Buffer.concat([r1.rest, all.subarray(30)]));
  assert.deepStrictEqual(r2.msgs.map((m) => parse(m).method), ['INVITE', 'BYE']);
  assert.strictEqual(r2.rest.length, 0);
});

test('dialog store tracks call state like sngrep and drops OPTIONS', () => {
  const store = new DialogStore();
  const steps = [];
  new PcapReader((p) => { const m = parse(p.payload); store.add(p, m); steps.push(store.get(CID) && store.get(CID).state); }).push(callPcap());
  assert.deepStrictEqual(steps.slice(0, 7), ['CALL SETUP', 'CALL SETUP', 'RINGING', 'IN CALL', 'IN CALL', 'COMPLETED', 'COMPLETED']);
  const [g] = store.list();
  assert.strictEqual(store.list().length, 1);   // OPTIONS ignored
  assert.strictEqual(g.count, 7); assert.strictEqual(g.from, '1100'); assert.strictEqual(g.xnum, '9876543210');
  assert.strictEqual(g.sdp.length, 2);
  assert.strictEqual(store.list({ q: '98765' }).length, 1);
  assert.strictEqual(store.list({ q: 'nomatch' }).length, 0);
});

test('dialog store: rejected and cancelled calls, auth challenge is not final', () => {
  const s = new DialogStore();
  const pkt = { ts: 1, src: '1.1.1.1', sport: 5060, dst: '2.2.2.2', dport: 5060, proto: 'udp', record: Buffer.alloc(0) };
  s.add(pkt, parse(req('INVITE', 1)));
  s.add(pkt, parse(resp(407, 'Proxy Authentication Required', 1, 'INVITE')));
  assert.strictEqual(s.get(CID).state, 'CALL SETUP');
  s.add(pkt, parse(resp(503, 'Service Unavailable', 2, 'INVITE')));
  assert.strictEqual(s.get(CID).state, 'REJECTED'); assert.strictEqual(s.get(CID).code, 503);
});

test('RTP analyzer: loss, sequence errors, one-way detection, DTMF ignored', () => {
  const an = new RtpAnalyzer();
  const rtp = (seq, ts, pt = 8) => { const b = Buffer.alloc(172); b[0] = 0x80; b[1] = pt; b.writeUInt16BE(seq, 2); b.writeUInt32BE(ts, 4); b.writeUInt32BE(0xdeadbeef, 8); return b; };
  let t = 0;
  for (let i = 0; i < 100; i++) {
    if (i === 50 || i === 51) continue;   // two lost packets
    an.add({ ts: (t = i * 20), src: '10.0.0.5', sport: 12000, dst: '172.20.10.201', dport: 15000, proto: 'udp', payload: rtp((65500 + i) % 65536, i * 160) });
  }
  an.add({ ts: t + 5, src: '10.0.0.5', sport: 12000, dst: '172.20.10.201', dport: 15000, proto: 'udp', payload: rtp(1, 0, 101) });
  assert.strictEqual(an.add({ ts: 1, src: 'a', sport: 1, dst: 'b', dport: 2, proto: 'udp', payload: Buffer.from('not rtp at all!!') }), false);
  const [s] = an.streams();
  assert.strictEqual(s.codec, 'PCMA'); assert.strictEqual(s.packets, 99); assert.strictEqual(s.events, 1);
  assert.strictEqual(s.expected, 100); assert.strictEqual(s.lost, 2); assert.strictEqual(s.lossPct, 2);   // across the 16-bit wrap
  assert.strictEqual(s.seqErrors, 1); assert.strictEqual(s.maxDeltaMs, 60); assert.strictEqual(s.jitterMs < 5, true);
  assert.ok(s.oneWay); assert.ok(s.problems.some((p) => /one-way/.test(p))); assert.ok(s.problems.some((p) => /2% loss/.test(p)));
});

test('message log keeps every SIP message in order, filters by type and text, polls with after', () => {
  const log = new MessageLog(5);
  const pkt = (ts) => ({ ts, src: '10.0.0.5', sport: 5060, dst: '172.20.10.201', dport: 5060, proto: 'udp' });
  const reg = `REGISTER sip:172.20.10.201 SIP/2.0\r\nFrom: <sip:acme@x>;tag=1\r\nTo: <sip:acme@x>\r\nCall-ID: r1\r\nCSeq: 1 REGISTER\r\n\r\n`;
  [req('INVITE', 1), resp(100, 'Trying', 1, 'INVITE'), resp(180, 'Ringing', 1, 'INVITE'), reg,
    resp(401, 'Unauthorized', 1, 'REGISTER').replace(CID, 'r1'), resp(200, 'OK', 1, 'INVITE')].forEach((t, i) => log.add(pkt(i), parse(t)));
  assert.strictEqual(log.list.length, 5);   // ring buffer
  assert.deepStrictEqual(log.since(0).map((e) => e.label), ['100 Trying', '180 Ringing', 'REGISTER', '401 Unauthorized', '200 OK']);
  assert.deepStrictEqual(log.since(0, { types: new Set(['register']) }).map((e) => e.label), ['REGISTER', '401 Unauthorized']);
  assert.deepStrictEqual(log.since(0, { types: new Set(['call']) }).map((e) => e.code), [100, 180, 200]);
  assert.deepStrictEqual(log.since(4).map((e) => e.id), [5, 6]);
  assert.deepStrictEqual(log.since(0, { q: 'r1' }).map((e) => e.label), ['REGISTER', '401 Unauthorized']);   // by Call-ID
});
