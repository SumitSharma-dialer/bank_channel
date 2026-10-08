'use strict';
// Streaming pcap reader (what `tcpdump -w -` writes) -> decoded UDP/TCP packets. Pure, no I/O (unit tested).
// Link types: Ethernet (1), raw IP (12/101), Linux cooked v1 (113) and v2 (276, what `-i any` gives).

const LINK_ETH = 1, LINK_RAW = [12, 101], LINK_SLL = 113, LINK_SLL2 = 276, LINK_NULL = 0;

function ipv4(b) { return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`; }
function ipv6(b) {
  const g = []; for (let i = 0; i < 16; i += 2) g.push(((b[i] << 8) | b[i + 1]).toString(16));
  let bs = -1, bl = 1;                           // longest run of zero groups -> "::"
  for (let i = 0; i < 8; i++) {
    let j = i; while (j < 8 && g[j] === '0') j++;
    if (j - i > bl) { bs = i; bl = j - i; }
    i = Math.max(i, j);
  }
  return bs < 0 ? g.join(':') : `${g.slice(0, bs).join(':')}::${g.slice(bs + bl).join(':')}`;
}

class PcapReader {
  // onPacket({ ts (ms, float), src, sport, dst, dport, proto: 'udp'|'tcp', payload: Buffer, record: Buffer })
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.buf = Buffer.alloc(0);
    this.header = null;          // global header Buffer (24 bytes), kept to write sub-captures
    this.le = true; this.nano = false; this.link = null;
    this.frags = new Map();      // IPv4 reassembly: key -> { parts: [{off, data}], total, at }
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.header) {
      if (this.buf.length < 24) return;
      const m = this.buf.readUInt32LE(0);
      if (m === 0xa1b2c3d4 || m === 0xa1b23c4d) this.le = true;
      else if (this.buf.readUInt32BE(0) === 0xa1b2c3d4 || this.buf.readUInt32BE(0) === 0xa1b23c4d) this.le = false;
      else throw new Error('not a pcap stream');
      this.nano = (this.le ? m : this.buf.readUInt32BE(0)) === 0xa1b23c4d;
      this.link = this.le ? this.buf.readUInt32LE(20) : this.buf.readUInt32BE(20);
      this.header = Buffer.from(this.buf.subarray(0, 24));
      this.buf = this.buf.subarray(24);
    }
    const u32 = (o) => (this.le ? this.buf.readUInt32LE(o) : this.buf.readUInt32BE(o));
    while (this.buf.length >= 16) {
      const incl = u32(8);
      if (incl > 262144) throw new Error('corrupt pcap record');
      if (this.buf.length < 16 + incl) break;
      const ts = u32(0) * 1000 + u32(4) / (this.nano ? 1e6 : 1e3);
      const record = Buffer.from(this.buf.subarray(0, 16 + incl));
      this.buf = this.buf.subarray(16 + incl);
      try { this.decode(ts, record.subarray(16), record); } catch { /* malformed packet: skip */ }
    }
  }

  decode(ts, d, record) {
    let off, proto;
    if (this.link === LINK_SLL2) { proto = d.readUInt16BE(0); off = 20; }
    else if (this.link === LINK_SLL) { proto = d.readUInt16BE(14); off = 16; }
    else if (this.link === LINK_ETH) {
      proto = d.readUInt16BE(12); off = 14;
      while (proto === 0x8100 || proto === 0x88a8) { proto = d.readUInt16BE(off + 2); off += 4; }
    } else if (LINK_RAW.includes(this.link)) { proto = (d[0] >> 4) === 6 ? 0x86dd : 0x0800; off = 0; }
    else if (this.link === LINK_NULL) { const f = d.readUInt32LE(0); proto = f === 2 ? 0x0800 : 0x86dd; off = 4; }
    else return;
    if (proto === 0x0800) this.ip4(ts, d.subarray(off), record);
    else if (proto === 0x86dd) this.ip6(ts, d.subarray(off), record);
  }

  ip4(ts, d, record) {
    if ((d[0] >> 4) !== 4) return;
    const ihl = (d[0] & 0x0f) * 4;
    const total = Math.min(d.readUInt16BE(2), d.length);
    const flags = d.readUInt16BE(6);
    const fragOff = (flags & 0x1fff) * 8, more = (flags & 0x2000) !== 0;
    const src = ipv4(d.subarray(12, 16)), dst = ipv4(d.subarray(16, 20)), p = d[9];
    let body = d.subarray(ihl, total);
    if (more || fragOff) {                       // large SIP INVITEs over UDP get fragmented
      const key = `${src}>${dst}/${d.readUInt16BE(4)}/${p}`;
      const f = this.frags.get(key) || { parts: [], total: -1, at: ts };
      f.parts.push({ off: fragOff, data: Buffer.from(body) });
      if (!more) f.total = fragOff + body.length;
      this.frags.set(key, f);
      if (this.frags.size > 256) for (const [k, v] of this.frags) if (ts - v.at > 30000) this.frags.delete(k);
      if (f.total < 0) return;
      const have = f.parts.reduce((s, x) => s + x.data.length, 0);
      if (have < f.total) return;
      body = Buffer.alloc(f.total);
      for (const x of f.parts) x.data.copy(body, x.off);
      this.frags.delete(key);
    }
    this.l4(ts, p, src, dst, body, record);
  }

  ip6(ts, d, record) {
    if ((d[0] >> 4) !== 6) return;
    const len = d.readUInt16BE(4);
    this.l4(ts, d[6], ipv6(d.subarray(8, 24)), ipv6(d.subarray(24, 40)), d.subarray(40, 40 + len), record);
  }

  l4(ts, p, src, dst, d, record) {
    if (p === 17 && d.length >= 8) {
      const len = Math.min(d.readUInt16BE(4), d.length);
      this.onPacket({ ts, src, sport: d.readUInt16BE(0), dst, dport: d.readUInt16BE(2), proto: 'udp', payload: d.subarray(8, len), record });
    } else if (p === 6 && d.length >= 20) {
      const hl = (d[12] >> 4) * 4;
      const payload = d.subarray(hl);
      if (payload.length) this.onPacket({ ts, src, sport: d.readUInt16BE(0), dst, dport: d.readUInt16BE(2), proto: 'tcp', payload, record });
    }
  }
}

// pcap file from a global header + raw records (as kept by PcapReader)
const toPcap = (header, records) => Buffer.concat([header, ...records]);

module.exports = { PcapReader, toPcap };
