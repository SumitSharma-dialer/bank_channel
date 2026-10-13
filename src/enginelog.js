'use strict';
// Log lines of the SIP engine in use, oldest first, in Asterisk's layout "[time] LEVEL[pid] text" so the
// Diagnostics log search and the registration view work the same on both engines.
// Asterisk: tail of /var/log/asterisk/full. Kamailio: journalctl -u kamailio (the app user is in group systemd-journal).
const fs = require('fs/promises');
const { execFile } = require('child_process');
const cfg = require('./config');
const engine = require('./engine');

const KAM_LEVEL = { CRITICAL: 'ERROR', ALERT: 'ERROR', ERROR: 'ERROR', WARNING: 'WARNING', NOTICE: 'NOTICE', INFO: 'VERBOSE', DEBUG: 'DEBUG' };
// "2026-10-13T17:34:34+05:30 host kamailio[123]: WARNING: <core> [file.c:1]: text" -> "[2026-10-13 17:34:34] WARNING[123] <core> ..."
function kamLine(l) {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)\S*\s+\S+\s+([^\s\[:]+)(?:\[(\d+)\])?:\s?(.*)$/.exec(l);
  if (!m) return l;
  const lv = /^\s*(?:\d+\(\d+\)\s+)?([A-Z]+):\s?(.*)$/.exec(m[5]);
  return `[${m[1]} ${m[2]}] ${(lv && KAM_LEVEL[lv[1]]) || 'NOTICE'}[${m[4] || m[3]}] ${lv && KAM_LEVEL[lv[1]] ? lv[2] : m[5]}`;
}

const journal = (n) => new Promise((resolve, reject) => {
  execFile('journalctl', ['-u', 'kamailio', '-u', 'rtpengine-daemon', '-o', 'short-iso', '--no-pager', '-n', String(n)],
    { timeout: 8000, maxBuffer: 64 << 20 }, (err, out) => (err && !out ? reject(new Error(`journalctl: ${err.message}`)) : resolve(String(out).split('\n').filter(Boolean).map(kamLine))));
});

// -> { file, size, scannedBytes, lines }
async function tail(maxBytes = 4 * 1024 * 1024) {
  if (engine.name() === 'kamailio') {
    const lines = await journal(Math.max(2000, Math.round(maxBytes / 160)));
    return { file: 'journalctl -u kamailio -u rtpengine-daemon', size: null, scannedBytes: lines.reduce((s, l) => s + l.length + 1, 0), lines };
  }
  const fh = await fs.open(cfg.asterisk.log, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes), buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift();   // partial first line
    return { file: cfg.asterisk.log, size, scannedBytes: len, lines };
  } finally { await fh.close(); }
}

module.exports = { tail, kamLine };
