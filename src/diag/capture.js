'use strict';
// tcpdump runner: live SIP trace (sngrep-like dialog store), time-boxed pcap downloads and RTP stream analysis.
// tcpdump needs CAP_NET_RAW: sipdist.service grants it with AmbientCapabilities (see deploy/sipdist.service).
const { spawn, execFileSync } = require('child_process');
const cfg = require('../config');
const { PcapReader, toPcap } = require('./pcap');
const { parse, splitStream, DialogStore } = require('./sip');
const { RtpAnalyzer } = require('./rtp');

const TCPDUMP = process.env.TCPDUMP_BIN || 'tcpdump';
const MAX_JOBS = 3;                  // tcpdump processes at once (trace + downloads + RTP)
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|[0-9a-fA-F:]{2,39})$/;
let jobs = 0;

function which(bin) {
  try { return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', timeout: 2000 }).trim() || null; } catch { return null; }
}
const tools = () => ({ tcpdump: which(TCPDUMP), tshark: which('tshark'), sngrep: which('sngrep') });

// Structured filter -> BPF expression. Only validated values reach tcpdump (no free-text filter).
function bpf({ port, sip = true, rtp = false }) {
  const parts = [];
  const sipPorts = [...new Set([cfg.sipPort, 5060, 5061])];
  if (sip) parts.push(`(${sipPorts.map((p) => `port ${p}`).join(' or ')})`);
  if (rtp) parts.push(`(udp portrange ${cfg.rtp.start}-${cfg.rtp.end})`);
  if (port) parts.push(`(port ${port})`);
  return parts.length ? `(${parts.join(' or ')})` : 'udp or tcp';
}

function checkFilter(o) {
  if (o.host && !IP_RE.test(o.host)) { const e = new Error('host must be an IP address or CIDR'); e.status = 400; throw e; }
  if (o.port != null && o.port !== '' && !(Number.isInteger(+o.port) && +o.port > 0 && +o.port < 65536)) {
    const e = new Error('port must be 1-65535'); e.status = 400; throw e;
  }
  return o;
}
// tcpdump "host" does not take a CIDR, "net" does
const hostExpr = (h) => (h && h.includes('/') ? `net ${h}` : h ? `host ${h}` : '');

// spawn tcpdump writing pcap to stdout. Resolves stderr text when it ends.
function run(filter, { maxPackets = 0 } = {}) {
  if (jobs >= MAX_JOBS) { const e = new Error(`too many captures running (max ${MAX_JOBS})`); e.status = 429; throw e; }
  const args = ['-i', 'any', '-p', '-nn', '-U', '-s', '0', '-w', '-'];
  if (maxPackets) args.push('-c', String(maxPackets));
  const proc = spawn(TCPDUMP, [...args, filter], { stdio: ['ignore', 'pipe', 'pipe'] });
  jobs++;
  let err = '';
  proc.stderr.on('data', (b) => { if (err.length < 4000) err += b; });
  proc.done = new Promise((resolve) => {
    let ended = false;
    const fin = (code) => { if (ended) return; ended = true; jobs--; resolve({ code, stderr: err.trim() }); };
    proc.on('close', fin);
    proc.on('error', (e) => { err += e.message; fin(-1); });
  });
  return proc;
}
const permHint = (stderr) => (/permitted|permission|denied/i.test(stderr)
  ? `${stderr} — the service needs CAP_NET_RAW: add "AmbientCapabilities=CAP_NET_RAW" to sipdist.service and restart`
  : stderr);

// ------------------------------------------------------------------ live SIP trace
const trace = {
  store: new DialogStore(),
  proc: null, started: null, until: null, filter: '', error: null, packets: 0, timer: null,

  status() {
    return { running: !!this.proc, started: this.started, until: this.until, filter: this.filter, error: this.error,
      packets: this.packets, dialogs: this.store.d.size, keepNoise: this.store.keepNoise };
  },

  start({ minutes = 10, host = '', keepNoise = false } = {}) {
    if (this.proc) this.stop();
    checkFilter({ host });
    minutes = Math.max(1, Math.min(60, +minutes || 10));
    const hx = hostExpr(host);
    const filter = `${hx ? hx + ' and ' : ''}${bpf({})}`;
    const proc = run(filter);   // throws when too many captures run: keep the old state then
    this.filter = filter;
    this.store.keepNoise = !!keepNoise;
    this.error = null; this.packets = 0;
    this.started = Date.now(); this.until = this.started + minutes * 60e3;
    const tcp = new Map();   // TCP flow -> pending bytes
    const reader = new PcapReader((pkt) => {
      this.packets++;
      const feed = (buf) => { const m = parse(buf); if (m) this.store.add(pkt, m); };
      if (pkt.proto === 'udp') return feed(pkt.payload);
      const k = `${pkt.src}:${pkt.sport}>${pkt.dst}:${pkt.dport}`;
      const r = splitStream(Buffer.concat([tcp.get(k) || Buffer.alloc(0), pkt.payload]));
      r.rest.length ? tcp.set(k, r.rest) : tcp.delete(k);
      if (tcp.size > 2000) tcp.clear();
      r.msgs.forEach(feed);
    });
    this.proc = proc;
    this.header = null;
    proc.stdout.on('data', (b) => {
      try { reader.push(b); this.header = reader.header; } catch (e) { this.error = e.message; proc.kill(); }
    });
    proc.done.then(({ code, stderr }) => {
      if (this.proc !== proc) return;            // stopped by us
      this.proc = null; this.until = Date.now(); clearTimeout(this.timer);
      if (!this.error) this.error = permHint(stderr) || `tcpdump exited (${code})`;
    });
    this.timer = setTimeout(() => this.stop(), minutes * 60e3);
    return this.status();
  },

  stop() {
    clearTimeout(this.timer);
    if (this.proc) { this.proc.kill('SIGTERM'); this.proc = null; }
    this.until = Date.now();
    return this.status();
  },

  clear() { this.store.clear(); this.packets = 0; return this.status(); },

  pcap(callId) {
    const g = this.store.get(callId);
    if (!g || !this.header) return null;
    return toPcap(this.header, g.records);
  },
};

function emptyPcap() {   // global header only, Linux cooked v2 like `-i any`
  const b = Buffer.alloc(24);
  b.writeUInt32LE(0xa1b2c3d4, 0); b.writeUInt16LE(2, 4); b.writeUInt16LE(4, 6); b.writeUInt32LE(262144, 16); b.writeUInt32LE(276, 20);
  return b;
}

// ------------------------------------------------------------------ pcap download (streamed)
// Writes pcap straight to the HTTP response for `seconds`, or until maxBytes / client disconnect.
async function download(res, { seconds = 30, host = '', port = '', rtp = false, sip = true }) {
  const o = checkFilter({ host, port });
  seconds = Math.max(1, Math.min(300, +seconds || 30));
  const hx = hostExpr(o.host);
  const filter = `${hx ? hx + ' and ' : ''}${bpf({ sip, rtp, port: o.port ? +o.port : 0 })}`;
  const proc = run(filter, { maxPackets: 500000 });
  const maxBytes = 200 * 1024 * 1024;
  let bytes = 0, started = false;
  const stop = () => proc.kill('SIGTERM');
  const timer = setTimeout(stop, seconds * 1000);
  res.on('close', stop);
  proc.stdout.on('data', (b) => {
    if (!started) {
      started = true;
      res.setHeader('Content-Type', 'application/vnd.tcpdump.pcap');
      res.setHeader('Content-Disposition', `attachment; filename="sipdist_${new Date().toISOString().replace(/[:.]/g, '-')}.pcap"`);
    }
    bytes += b.length; res.write(b);
    if (bytes > maxBytes) stop();
  });
  const { code, stderr } = await proc.done;
  clearTimeout(timer);
  if (!started) {
    if (code) return res.status(500).json({ error: permHint(stderr) || `tcpdump exited (${code})` });
    // no matching traffic: a valid, empty capture
    res.setHeader('Content-Type', 'application/vnd.tcpdump.pcap');
    res.setHeader('Content-Disposition', 'attachment; filename="sipdist_empty.pcap"');
    return res.end(emptyPcap());
  }
  res.end();
}

// ------------------------------------------------------------------ RTP analysis
async function rtpCapture({ seconds = 10, host = '' }) {
  const o = checkFilter({ host });
  seconds = Math.max(2, Math.min(60, +seconds || 10));
  const hx = hostExpr(o.host);
  const filter = `${hx ? hx + ' and ' : ''}udp portrange ${cfg.rtp.start}-${cfg.rtp.end}`;
  const an = new RtpAnalyzer();
  let packets = 0, error = null;
  const reader = new PcapReader((pkt) => { packets++; an.add(pkt); });
  const proc = run(filter, { maxPackets: 2000000 });
  proc.stdout.on('data', (b) => { try { reader.push(b); } catch (e) { error = e.message; proc.kill(); } });
  const timer = setTimeout(() => proc.kill('SIGTERM'), seconds * 1000);
  const { code, stderr } = await proc.done;   // code null = stopped by our SIGTERM
  clearTimeout(timer);
  if (code) {
    const e = new Error(permHint(stderr) || 'tcpdump failed'); e.status = 500; throw e;
  }
  return { seconds, filter, packets, error, streams: an.streams() };
}

module.exports = { tools, trace, download, rtpCapture, bpf };
