'use strict';
// npm run originate -- <number> <did> [trunk]   — one test call straight out of a trunk (run as root)
// Number and DID are formatted like a live call: last 10 digits, then the trunk's prefix / strip_digits on the
// number and cli_prefix on the DID. Answered = Echo (you hear yourself: audio works both ways). Rings up to 45 s.
const fs = require('fs');
const { execFileSync } = require('child_process');
const { pool } = require('../db');

const SPOOL = '/var/spool/asterisk';
const LOG = '/var/log/asterisk/full';
const RING_SEC = 45;
const last10 = (v) => String(v || '').replace(/[^0-9]/g, '').slice(-10);

(async () => {
  const [number, did, trunkName] = process.argv.slice(2);
  if (last10(number).length < 10 || last10(did).length < 10) {
    console.error('usage: npm run originate -- <number> <did> [trunk]   e.g. npm run originate -- 9971748367 8064258451 tata_r2s');
    process.exit(2);
  }
  const { rows } = await pool.query(
    'SELECT name,prefix,strip_digits,cli_prefix FROM trunks WHERE active AND ($1::text IS NULL OR name=$1) ORDER BY name', [trunkName || null]);
  await pool.end();
  if (rows.length !== 1) {
    console.error(trunkName ? `no active trunk "${trunkName}"` : `pick a trunk: ${rows.map((t) => t.name).join(', ')}`);
    process.exit(2);
  }
  const t = rows[0];
  const out = (t.prefix || '') + last10(number).slice(+t.strip_digits || 0);
  const cli = (t.cli_prefix || '') + last10(did);
  const chan = `PJSIP/${out}@t_${t.name}`;

  // write in tmp, then rename: Asterisk must never read a half-written call file
  const name = `sd-originate-${Date.now()}.call`;
  const tmp = `${SPOOL}/tmp/${name}`;
  fs.writeFileSync(tmp, `Channel: ${chan}\nCallerID: "${cli}" <${cli}>\nWaitTime: ${RING_SEC}\nMaxRetries: 0\n` +
    `Application: Echo\nArchive: no\n`);
  execFileSync('chown', ['asterisk:asterisk', tmp]);
  const from = fs.statSync(LOG).size;
  fs.renameSync(tmp, `${SPOOL}/outgoing/${name}`);
  console.log(`calling ${out} from ${cli} via ${t.name} (rings up to ${RING_SEC} s, answered = echo test)`);

  // follow the Asterisk log until the spooler reports the result
  const seen = new Set();
  const until = Date.now() + (RING_SEC + 15) * 1000;
  let channel = null;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    const fd = fs.openSync(LOG, 'r');
    const buf = Buffer.alloc(Math.max(0, fs.statSync(LOG).size - from));
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    for (const line of buf.toString().split('\n')) {
      if (!line.includes(out) && !(channel && line.includes(channel))) continue;
      const ch = line.match(/(PJSIP\/t_[a-z0-9_]+-[0-9a-f]+)/);
      if (ch && !channel) channel = ch[1];
      const msg = (line.match(/is making progress|is ringing|answered|Call failed[^\n]*|Hungup[^\n]*|hangupcause[^\n]*|Spawn extension[^\n]*/i) || [])[0];
      if (msg && !seen.has(msg)) { seen.add(msg); console.log(`${line.slice(1, 16)}  ${msg}`); }
      if (/Call failed|expired without completion/.test(line)) process.exit(1);
      if (/Spawn extension|Auto fallthrough|Hungup/.test(line) && seen.size) process.exit(0);
    }
    if (channel) {
      const live = execFileSync('asterisk', ['-rx', 'core show channels concise']).toString();
      if (seen.size && !live.includes(channel)) { console.log('call ended'); process.exit(0); }
    }
  }
  console.log('no result in time — check: asterisk -rx "core show channels"');
})().catch((e) => { console.error(e.message); process.exit(1); });
