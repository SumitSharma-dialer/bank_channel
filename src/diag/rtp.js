'use strict';
// RTP stream analysis like `tshark -z rtp,streams`: per SSRC packets, loss, sequence errors, max delta, jitter
// (RFC 3550). Pure, no I/O.

const CODEC = { 0: 'PCMU', 3: 'GSM', 4: 'G723', 8: 'PCMA', 9: 'G722', 18: 'G729', 13: 'CN' };
const RATE = 8000;   // all narrowband codecs (and G722, by RFC 3551) use an 8 kHz RTP clock

class RtpAnalyzer {
  constructor() { this.s = new Map(); }

  // pkt from PcapReader (UDP only). Returns false for non-RTP payloads.
  add(pkt) {
    const p = pkt.payload;
    if (pkt.proto !== 'udp' || p.length < 12 || (p[0] >> 6) !== 2) return false;
    const pt = p[1] & 0x7f;
    if (pt >= 72 && pt <= 76) return false;               // RTCP
    const seq = p.readUInt16BE(2), ts = p.readUInt32BE(4), ssrc = p.readUInt32BE(8);
    const key = `${pkt.src}:${pkt.sport}>${pkt.dst}:${pkt.dport}/${ssrc}`;
    let s = this.s.get(key);
    if (!s) {
      s = { src: `${pkt.src}:${pkt.sport}`, dst: `${pkt.dst}:${pkt.dport}`, ssrc: ssrc.toString(16).padStart(8, '0'),
        pt, first: pkt.ts, last: pkt.ts, packets: 0, baseSeq: seq, maxSeq: seq, cycles: 0, seqErrors: 0,
        maxDelta: 0, jitter: 0, maxJitter: 0, events: 0, prevArr: null, prevTs: null, marker: 0 };
      this.s.set(key, s);
      if (this.s.size > 5000) this.s.delete(this.s.keys().next().value);
    }
    s.packets++;
    if (p[1] & 0x80) s.marker++;
    if (pt === 101 || (pt >= 96 && pt !== s.pt && s.pt < 96)) { s.events++; s.last = pkt.ts; return true; }   // DTMF events
    // extended sequence number (RFC 3550 A.1, simplified)
    const d = (seq - (s.maxSeq & 0xffff) + 0x10000) % 0x10000;
    if (s.packets > 1) {
      if (d === 0 || d > 0x8000) s.seqErrors++;            // duplicate or out of order
      else {
        if (d !== 1) s.seqErrors++;
        if (seq < (s.maxSeq & 0xffff)) s.cycles += 0x10000;
        s.maxSeq = s.cycles + seq;
      }
      const delta = pkt.ts - s.last;
      if (delta > s.maxDelta) s.maxDelta = delta;
      if (s.prevArr != null) {
        const D = (pkt.ts - s.prevArr) * (RATE / 1000) - ((ts - s.prevTs) | 0);
        s.jitter += (Math.abs(D) - s.jitter) / 16;
        if (s.jitter > s.maxJitter) s.maxJitter = s.jitter;
      }
    }
    s.prevArr = pkt.ts; s.prevTs = ts; s.last = pkt.ts;
    return true;
  }

  streams() {
    const list = [...this.s.values()].map((s) => {
      const audio = s.packets - s.events;
      const expected = audio ? s.maxSeq - s.baseSeq + 1 : 0;
      const lost = Math.max(0, expected - audio);
      return { src: s.src, dst: s.dst, ssrc: s.ssrc, pt: s.pt, codec: CODEC[s.pt] || (s.pt >= 96 ? `dyn ${s.pt}` : `PT ${s.pt}`),
        packets: s.packets, events: s.events, expected, lost, lossPct: expected ? +(100 * lost / expected).toFixed(2) : 0,
        seqErrors: s.seqErrors, maxDeltaMs: +s.maxDelta.toFixed(1),
        jitterMs: +(s.jitter / (RATE / 1000)).toFixed(2), maxJitterMs: +(s.maxJitter / (RATE / 1000)).toFixed(2),
        durationSec: +((s.last - s.first) / 1000).toFixed(1), start: s.first };
    });
    // one-way audio: a stream with no stream coming back the other way
    const ends = new Set(list.map((x) => `${x.src}>${x.dst}`));
    for (const x of list) {
      x.oneWay = !ends.has(`${x.dst}>${x.src}`);
      x.problems = [];
      if (x.oneWay) x.problems.push('one-way (no reverse stream)');
      if (x.lossPct >= 1) x.problems.push(`${x.lossPct}% loss`);
      if (x.jitterMs >= 30) x.problems.push(`jitter ${x.jitterMs} ms`);
      if (x.maxDeltaMs >= 200) x.problems.push(`gap ${Math.round(x.maxDeltaMs)} ms`);
    }
    return list.sort((a, b) => a.start - b.start);
  }
}

module.exports = { RtpAnalyzer };
