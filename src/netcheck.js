'use strict';
// Connection check from the SIP trunks / Processes pages: can this server reach host:port?
//   ping  ICMP echo x4 -> loss + round trip
//   tcp   TCP connect, then a SIP OPTIONS on the connection -> open / refused / timeout (+ the SIP reply, if any)
//   udp   SIP OPTIONS datagram -> SIP reply / port closed (ICMP unreachable) / no reply
// UDP has no handshake, so a SIP reply is the only proof the port answers. Sent from a random local port (Asterisk
// holds 5060): a carrier that only answers source port 5060 shows "no reply" here although live calls work.
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const { execFile } = require('child_process');

const TIMEOUT = 3000;
const rnd = () => crypto.randomBytes(6).toString('hex');

function options(host, port, proto, lip, lport) {
  return [`OPTIONS sip:${host}:${port} SIP/2.0`,
    `Via: SIP/2.0/${proto} ${lip}:${lport};branch=z9hG4bK${rnd()};rport`,
    'Max-Forwards: 70', `From: <sip:check@${lip}>;tag=${rnd()}`, `To: <sip:${host}:${port}>`,
    `Call-ID: ${rnd()}@${lip}`, 'CSeq: 1 OPTIONS', `Contact: <sip:check@${lip}:${lport}>`,
    'User-Agent: sipdist-check', 'Content-Length: 0', '', ''].join('\r\n');
}
const statusLine = (buf) => {
  const m = /^SIP\/2\.0 (\d{3})([^\r\n]*)/.exec(buf.toString('latin1'));
  return m ? `${m[1]}${m[2]}`.trim() : null;
};

function ping(host) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile('ping', ['-n', '-c', '4', '-i', '0.3', '-W', '1', host], { timeout: 8000 }, (err, out, errOut) => {
      const s = String(out || '');
      const m = /(\d+) packets transmitted, (\d+) received/.exec(s);
      const rtt = /= ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(s);
      if (!m) return resolve({ ok: false, text: String(errOut || err?.message || 'ping failed').trim().split('\n')[0], ms: Date.now() - t0 });
      const sent = +m[1], got = +m[2];
      resolve({ ok: got > 0, sent, received: got, loss: Math.round(100 * (sent - got) / sent),
        avg: rtt ? +rtt[2] : null, max: rtt ? +rtt[3] : null,
        text: got ? `${got}/${sent} replies, ${Math.round(100 * (sent - got) / sent)}% loss, avg ${rtt ? rtt[2] : '?'} ms` : `no reply (${sent} sent) — ICMP may be blocked`, ms: Date.now() - t0 });
    });
  });
}

function tcp(host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let connected = 0, done = false;
    const s = net.connect({ host, port });
    const end = (r) => { if (done) return; done = true; s.destroy(); resolve({ ...r, ms: Date.now() - t0 }); };
    s.setTimeout(TIMEOUT, () => end(connected
      ? { ok: true, connect: connected, text: `port open (connected in ${connected} ms), no SIP reply` }
      : { ok: false, text: `timeout after ${TIMEOUT / 1000} s — filtered or host down` }));
    s.on('connect', () => {
      connected = Date.now() - t0;
      s.write(options(host, port, 'TCP', s.localAddress, s.localPort));
    });
    s.on('data', (d) => end({ ok: true, connect: connected, sip: statusLine(d), text: `port open (connected in ${connected} ms)` }));
    s.on('error', (e) => end(connected
      ? { ok: true, connect: connected, text: `port open (connected in ${connected} ms), closed after OPTIONS` }
      : { ok: false, text: e.code === 'ECONNREFUSED' ? 'refused — nothing listening on this TCP port' : `${e.code || e.message}` }));
    s.on('close', () => end({ ok: true, connect: connected, text: `port open (connected in ${connected} ms), closed without SIP reply` }));
  });
}

function udp(host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false, timer = null;
    const s = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    const end = (r) => { if (done) return; done = true; clearTimeout(timer); s.close(); resolve({ ...r, ms: Date.now() - t0 }); };
    s.on('message', (d) => end({ ok: true, sip: statusLine(d), text: `SIP reply in ${Date.now() - t0} ms` }));
    s.on('error', (e) => end(e.code === 'ECONNREFUSED'
      ? { ok: false, text: 'port closed (ICMP port unreachable)' } : { ok: false, text: `${e.code || e.message}` }));
    s.connect(port, host, (e) => {
      if (e) return end({ ok: false, text: `${e.code || e.message}` });
      const a = s.address();
      s.send(options(host, port, 'UDP', a.address, a.port));
      timer = setTimeout(() => end({ ok: null, text: `no reply in ${TIMEOUT / 1000} s — filtered, or the far end only answers known IPs / port 5060` }), TIMEOUT);
    });
  });
}

async function check(host, port) {
  const [p, t, u] = await Promise.all([ping(host), tcp(host, port), udp(host, port)]);
  return { host, port, at: Date.now(), ping: p, tcp: t, udp: u };
}

module.exports = { check, ping, tcp, udp };
