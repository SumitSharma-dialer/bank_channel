'use strict';
// tcpdump runner: live SIP trace (sngrep-like dialog store), time-boxed pcap downloads and RTP stream analysis.
// tcpdump needs CAP_NET_RAW: sipdist.service grants it with AmbientCapabilities (see deploy/sipdist.service).
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('../config');
const { PcapReader, toPcap } = require('./pcap');
const { parse, splitStream, DialogStore } = require('./sip');
const { RtpAnalyzer } = require('./rtp');

const TCPDUMP = process.env.TCPDUMP_BIN || 'tcpdump';
const SNGREP = process.env.SNGREP_BIN || 'sngrep';
const MAX_JOBS = 3;                  // tcpdump processes at once (trace + downloads + RTP)
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|[0-9a-fA-F:]{2,39})$/;
let jobs = 0;

function which(bin) {
  try { return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', timeout: 2000 }).trim() || null; } catch { return null; }
}
const tools = () => ({ tcpdump: which(TCPDUMP), tshark: which('tshark'), sngrep: which(SNGREP) });

// Structured filter -> BPF expression. Only validated values reach tcpdump (no free-text filter).
function bpf({ port, sip = true, rtp = false }) {
  const parts = [];
  const sipPorts = [...new Set([cfg.sipPort, 5060, 5061])];
  if (sip) parts.push(`(${sipPorts.map((p) => `port ${p}`).join(' or ')})`);
  if (rtp) parts.push(`(udp portrange ${cfg.rtp.start}-${cfg.rtp.end})`);
  if (port) parts.push(`(port ${port})`);
  return parts.length ? `(${parts.join(' or ')})` : 'udp or tcp';
}

// o.hosts: [ip | cidr] (already resolved from a trunk / process / custom IP), [] = all traffic
function checkFilter(o) {
  o.hosts = (o.hosts || []).filter(Boolean);
  if (o.hosts.length > 32) { const e = new Error('too many IPs in the filter (max 32)'); e.status = 400; throw e; }
  for (const h of o.hosts) if (!IP_RE.test(h)) { const e = new Error(`not an IP address or CIDR: ${h}`); e.status = 400; throw e; }
  if (o.port != null && o.port !== '' && !(Number.isInteger(+o.port) && +o.port > 0 && +o.port < 65536)) {
    const e = new Error('port must be 1-65535'); e.status = 400; throw e;
  }
  return o;
}
// tcpdump "host" does not take a CIDR, "net" does. -> "(host a or net b/24) and " or ''
function hostExpr(hosts) {
  if (!hosts.length) return '';
  return `(${hosts.map((h) => (h.includes('/') ? `net ${h}` : `host ${h}`)).join(' or ')}) and `;
}

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
    return { running: !!this.proc, started: this.started, until: this.until, filter: this.filter, label: this.label, error: this.error,
      packets: this.packets, dialogs: this.store.d.size, keepNoise: this.store.keepNoise };
  },

  start({ minutes = 10, hosts = [], label = '', keepNoise = false } = {}) {
    if (this.proc) this.stop();
    checkFilter({ hosts });
    minutes = Math.max(1, Math.min(60, +minutes || 10));
    const filter = `${hostExpr(hosts)}${bpf({})}`;
    const proc = run(filter);   // throws when too many captures run: keep the old state then
    this.filter = filter; this.label = label;
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
async function download(res, { seconds = 30, hosts = [], port = '', rtp = false, sip = true, tool = 'tcpdump', match = '', name = '' }) {
  const o = checkFilter({ hosts, port });
  seconds = Math.max(1, Math.min(300, +seconds || 30));
  const filter = `${hostExpr(o.hosts)}${bpf({ sip, rtp, port: o.port ? +o.port : 0 })}`;
  if (tool === 'sngrep') return sngrepDownload(res, { seconds, filter, rtp, match, name });
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
      res.setHeader('Content-Disposition', `attachment; filename="${fileName('tcpdump', name)}"`);
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

const fileName = (tool, name) =>
  `${tool}_${name ? name.replace(/[^A-Za-z0-9_.-]/g, '_') + '_' : ''}${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.pcap`;

// sngrep headless (-N -q): keeps only SIP dialogs matching `match` (a number, IP, Call-ID...) and writes them with -O.
// It cannot write to stdout, so it writes a temp file that is sent when the time is up.
const MATCH_RE = /^[A-Za-z0-9+@._:-]{1,64}$/;
async function sngrepDownload(res, { seconds, filter, rtp, match, name }) {
  if (match && !MATCH_RE.test(match)) { const e = new Error('match: letters, digits and + @ . _ : - only'); e.status = 400; throw e; }
  if (jobs >= MAX_JOBS) { const e = new Error(`too many captures running (max ${MAX_JOBS})`); e.status = 429; throw e; }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sipdist-sngrep-'));
  const file = path.join(dir, 'capture.pcap');
  // the first free argument is the match expression (regex); '.' = every dialog
  const args = ['-N', '-q', '-F', '-d', 'any', '-O', file, ...(rtp ? ['-r'] : []), match ? match.replace(/[.+]/g, '\\$&') : '.', ...filter.split(' ')];
  const proc = spawn(SNGREP, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  jobs++;
  let err = '';
  proc.stderr.on('data', (b) => { if (err.length < 4000) err += b; });
  const done = new Promise((resolve) => {
    let ended = false;
    const fin = (code) => { if (!ended) { ended = true; jobs--; resolve(code); } };
    proc.on('close', fin); proc.on('error', (e) => { err += e.message; fin(-1); });
  });
  const stop = () => proc.kill('SIGTERM');
  const timer = setTimeout(stop, seconds * 1000);
  const sizeCheck = setInterval(() => fs.stat(file, (e, st) => { if (st && st.size > 200 * 1024 * 1024) stop(); }), 1000);
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) { aborted = true; stop(); } });
  const code = await done;
  clearTimeout(timer); clearInterval(sizeCheck);
  try {
    if (aborted) return;
    const st = await fs.promises.stat(file).catch(() => null);
    if (!st) {
      if (code) return res.status(500).json({ error: permHint(err.trim()) || `sngrep exited (${code})` });
      res.setHeader('Content-Type', 'application/vnd.tcpdump.pcap');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName('sngrep_empty', name)}"`);
      return res.end(emptyPcap());
    }
    res.setHeader('Content-Type', 'application/vnd.tcpdump.pcap');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName('sngrep', name)}"`);
    res.setHeader('Content-Length', st.size);
    await new Promise((resolve) => fs.createReadStream(file).on('close', resolve).pipe(res));
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------------ RTP analysis
async function rtpCapture({ seconds = 10, hosts = [] }) {
  const o = checkFilter({ hosts });
  seconds = Math.max(2, Math.min(60, +seconds || 10));
  const filter = `${hostExpr(o.hosts)}udp portrange ${cfg.rtp.start}-${cfg.rtp.end}`;
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
