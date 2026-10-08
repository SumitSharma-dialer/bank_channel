'use strict';
// ARI events -> Redis live counters -> PostgreSQL calls + daily_stats -> WebSocket.
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const cfg = require('./config');
const redis = require('./redis');
const ari = require('./ari');
const { q } = require('./db');
const { disposition, setRules } = require('./disposition');

const bus = new EventEmitter();          // 'hit', 'call', 'snapshot'
const CH_RE = /^PJSIP\/([pt])_([a-z0-9_]{2,32})-[0-9a-f]+$/;

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.statsTz, year: 'numeric', month: '2-digit', day: '2-digit' });
const today = (d = new Date()) => dayFmt.format(d);           // YYYY-MM-DD in STATS_TZ
const bucket = (t = Date.now()) => Math.floor(t / 10000);      // 10 s buckets

// ------------------------------------------------------------- metadata cache
let meta = { processes: [], trunks: [] };
async function refreshMeta() {
  const [p, t] = await Promise.all([
    q(`SELECT p.id,p.code,p.name,p.channel_limit,p.active,p.trunk_id,t.name AS trunk_name
         FROM processes p LEFT JOIN trunks t ON t.id=p.trunk_id ORDER BY p.code`),
    q('SELECT id,name,max_channels,active,register,host FROM trunks ORDER BY name'),
  ]);
  meta = { processes: p.rows, trunks: t.rows };
  // hangup cause rules (Dispositions page); a missing table (db:init not run yet) keeps the defaults
  const r = await q('SELECT cause,status,disposition FROM cause_rules').catch(() => null);
  if (r) setRules(r.rows);
}

// ------------------------------------------------------------- live counters
async function onCreated(ch) {
  const m = CH_RE.exec(ch.name || '');
  if (!m) return;
  const [, kind, code] = m;
  const day = today();
  const set = await redis.set(`sd:ch:${ch.id}`, `${kind}:${code}`, 'EX', 86400, 'NX');
  if (!set) return; // already counted (reconcile got there first)
  if (kind === 'p') {
    await redis.sdIncr('sd:live:proc', `sd:peak:proc:${day}`, code);
    const total = await redis.hincrby('sd:live:all', 'all', 1);
    await raisePeakAll(day, total);
    const b = bucket();
    await redis.multi()
      .incr(`sd:hits:${code}:${b}`).expire(`sd:hits:${code}:${b}`, 3600)
      .hincrby(`sd:hitsday:${day}`, code, 1).expire(`sd:hitsday:${day}`, 259200)
      .exec();
    bus.emit('hit', { process: code, at: Date.now(), number: ch.dialplan && ch.dialplan.exten });
  } else {
    await redis.sdIncr('sd:live:trunk', `sd:peak:trunk:${day}`, code);
  }
}

async function raisePeakAll(day, total) {
  const k = `sd:peak:proc:${day}`;
  const cur = +(await redis.hget(k, '__all')) || 0;
  if (total > cur) await redis.hset(k, '__all', total);
}

async function onDestroyed(ch) {
  const v = await redis.getdel(`sd:ch:${ch.id}`).catch(async () => {
    const x = await redis.get(`sd:ch:${ch.id}`); await redis.del(`sd:ch:${ch.id}`); return x;
  });
  if (!v) return;
  const [kind, code] = v.split(':');
  if (kind === 'p') {
    await redis.sdDecr('sd:live:proc', code);
    await redis.sdDecr('sd:live:all', 'all');
  } else {
    await redis.sdDecr('sd:live:trunk', code);
  }
}

// Every 10 s: rebuild counters from Asterisk's real channel list (self-healing).
async function reconcile() {
  if (!ari.connected) return;
  let chans;
  try { chans = await ari.channels(); } catch (e) { return; }
  const proc = {}, trunk = {};
  for (const p of meta.processes) proc[p.code] = 0;
  for (const t of meta.trunks) trunk[t.name] = 0;
  const m = redis.multi();
  let all = 0;
  for (const ch of chans) {
    const r = CH_RE.exec(ch.name || '');
    if (!r) continue;
    if (r[1] === 'p') { proc[r[2]] = (proc[r[2]] || 0) + 1; all++; } else trunk[r[2]] = (trunk[r[2]] || 0) + 1;
    m.set(`sd:ch:${ch.id}`, `${r[1]}:${r[2]}`, 'EX', 86400);
  }
  m.del('sd:live:proc', 'sd:live:trunk');
  if (Object.keys(proc).length) m.hset('sd:live:proc', proc);
  if (Object.keys(trunk).length) m.hset('sd:live:trunk', trunk);
  m.hset('sd:live:all', 'all', all);
  await m.exec();
}

// ------------------------------------------------------------- call records
const COL = { ANSWERED: 'answered', BUSY: 'busy', NO_ANSWER: 'no_answer', CANCEL: 'cancel', CONGESTION: 'congestion',
  FAILED: 'failed', CHANNEL_LIMIT: 'channel_limit', TRUNK_LIMIT: 'trunk_limit', BLOCKED: 'blocked',
  NO_ROUTE: 'no_route', INVALID: 'invalid', OFF_HOURS: 'off_hours', NO_HEADER: 'no_header', INVALID_DID: 'invalid_did', SIP_DOWN: 'sip_down' };
const NOT_ON_TRUNK = new Set(['CHANNEL_LIMIT', 'BLOCKED', 'NO_ROUTE', 'INVALID', 'OFF_HOURS', 'NO_HEADER', 'INVALID_DID']);
const HDR_STATUS = new Set(['none', 'ok', 'missing', 'bad_number', 'bad_did']);   // none = outbound call without headers
const digits = (v, n) => (String(v || '').replace(/[^0-9]/g, '').slice(0, n) || null);

async function saveCall(u) {
  const disp = disposition(u.disp, u.cause);
  const end = +u.end || Math.floor(Date.now() / 1000);
  const start = +u.start || end;
  const bill = Math.max(0, parseInt(u.bill, 10) || 0);
  const dialed = Math.max(0, parseInt(u.dialed, 10) || 0);
  const duration = Math.max(0, end - start);
  const answerAt = disp === 'ANSWERED' ? end - bill : null;
  const proc = meta.processes.find((p) => p.code === u.proc);
  const trunk = meta.trunks.find((t) => t.name === u.trunk);
  const src = String(u.src || '').replace(/:\d+$/, '');
  const hst = HDR_STATUS.has(u.hst) ? u.hst : null;              // outbound calls: header result; inbound: null
  const did = digits(u.did, 20) || (u.dir === 'in' ? digits(u.num, 20) : null);   // caller-ID DID (out) or called DID (in)

  const ins = await q(
    `INSERT INTO calls(uniqueid,linkedid,process_id,process_code,trunk_id,trunk_name,src_ip,cli_in,cli_out,
        dialed,sent_number,disposition,dialstatus,hangup_cause,start_time,answer_time,end_time,ring_sec,bill_sec,duration,direction,
        did,hdr_status,hdr_did,hdr_num)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,to_timestamp($15),
        CASE WHEN $16::bigint IS NULL THEN NULL ELSE to_timestamp($16) END,to_timestamp($17),$18,$19,$20,$21,$22,$23,$24,$25)
     ON CONFLICT (uniqueid) DO NOTHING RETURNING id`,
    [u.uid, u.linked || null, proc ? proc.id : null, u.proc || null, trunk ? trunk.id : null, u.trunk || null,
      src || null, u.cli || null, u.cliout || null, u.num || null, u.out || null, disp, u.dialstatus || null,
      parseInt(u.cause, 10) || null, start, answerAt, end, Math.max(0, dialed - bill), bill, duration, u.dir === 'in' ? 'in' : 'out',
      did, hst, hst && hst !== 'none' ? String(u.hdid || '').slice(0, 40) : null, hst && hst !== 'none' ? String(u.hnum || '').slice(0, 40) : null]);
  if (!ins.rowCount) return; // duplicate event

  const day = today(new Date(start * 1000));
  const col = COL[disp];
  const upsert = (scope, ref) => q(
    `INSERT INTO daily_stats(day,scope,ref,total,${col},talk_sec) VALUES($1,$2,$3,1,1,$4)
     ON CONFLICT (day,scope,ref) DO UPDATE SET total=daily_stats.total+1,
       ${col}=daily_stats.${col}+1, talk_sec=daily_stats.talk_sec+EXCLUDED.talk_sec`,
    [day, scope, ref, bill]);
  if (u.proc) await upsert('process', u.proc);
  if (u.trunk && !NOT_ON_TRUNK.has(disp)) await upsert('trunk', u.trunk);
  if (did) await upsert('did', did);

  bus.emit('call', { process: u.proc, trunk: u.trunk, number: u.num, disposition: disp, bill, at: end * 1000, dir: u.dir === 'in' ? 'in' : 'out' });
}

// Copy today's peaks from Redis to daily_stats.peak_channels.
async function flushPeaks() {
  const day = today();
  for (const [scope, key] of [['process', `sd:peak:proc:${day}`], ['trunk', `sd:peak:trunk:${day}`]]) {
    const h = await redis.hgetall(key);
    for (const [ref, v] of Object.entries(h)) {
      if (ref === '__all') continue;
      await q(`INSERT INTO daily_stats(day,scope,ref,peak_channels) VALUES($1,$2,$3,$4)
               ON CONFLICT (day,scope,ref) DO UPDATE SET peak_channels=GREATEST(daily_stats.peak_channels,EXCLUDED.peak_channels)`,
        [day, scope, ref, +v || 0]);
    }
  }
}

// ------------------------------------------------------------- trunk status
let trunkState = {};   // name -> { endpoint: 'online'|'offline'|..., reg: 'Registered'|... }
async function pollTrunkState() {
  const st = {};
  try {
    for (const e of await ari.endpoints()) {
      const m = /^t_([a-z0-9_]+)$/.exec(e.resource);
      if (m) st[m[1]] = { endpoint: e.state };
    }
  } catch { /* ARI down */ }
  await new Promise((resolve) => {
    execFile('asterisk', ['-rx', 'pjsip show registrations'], { timeout: 4000 }, (err, out) => {
      if (!err && out) {
        for (const line of out.split('\n')) {
          const m = /^\s*t_([a-z0-9_]+)-reg\/\S+\s+\S+\s+(\w+)/.exec(line);
          if (m) (st[m[1]] = st[m[1]] || {}).reg = m[2];
        }
      }
      resolve();
    });
  });
  trunkState = st;
}

// ------------------------------------------------------------- live snapshot
async function snapshot() {
  const day = today();
  const b = bucket();
  const [liveP, liveT, peakP, peakT, hitsDay, allLive] = await Promise.all([
    redis.hgetall('sd:live:proc'), redis.hgetall('sd:live:trunk'),
    redis.hgetall(`sd:peak:proc:${day}`), redis.hgetall(`sd:peak:trunk:${day}`),
    redis.hgetall(`sd:hitsday:${day}`), redis.hget('sd:live:all', 'all'),
  ]);
  const hitKeys = [];
  for (const p of meta.processes) for (let i = 0; i < 6; i++) hitKeys.push(`sd:hits:${p.code}:${b - i}`);
  const hitVals = hitKeys.length ? await redis.mget(hitKeys) : [];

  const processes = meta.processes.map((p, idx) => {
    let hm = 0; for (let i = 0; i < 6; i++) hm += +hitVals[idx * 6 + i] || 0;
    return { code: p.code, name: p.name, active: p.active, trunk: p.trunk_name, limit: p.channel_limit,
      live: +liveP[p.code] || 0, peak: +peakP[p.code] || 0, hitsMin: hm, hitsToday: +hitsDay[p.code] || 0 };
  });
  const trunks = meta.trunks.map((t) => ({
    name: t.name, active: t.active, max: t.max_channels, live: +liveT[t.name] || 0, peak: +peakT[t.name] || 0,
    state: (trunkState[t.name] || {}).endpoint || 'unknown',
    reg: t.register ? ((trunkState[t.name] || {}).reg || 'unknown') : 'n/a',
    assigned: meta.processes.filter((p) => p.trunk_id === t.id && p.active).reduce((s, p) => s + p.channel_limit, 0),
  }));
  const live = +allLive || processes.reduce((s, p) => s + p.live, 0);
  return {
    at: Date.now(), ariConnected: ari.connected, live,
    processCapacity: processes.filter((p) => p.active).reduce((s, p) => s + p.limit, 0),
    trunkCapacity: trunks.filter((t) => t.active).reduce((s, t) => s + (t.max || 0), 0),
    peakToday: +peakP.__all || 0,
    hitsMin: processes.reduce((s, p) => s + p.hitsMin, 0),
    hitsToday: processes.reduce((s, p) => s + p.hitsToday, 0),
    processes, trunks,
  };
}

// ------------------------------------------------------------- wiring
function start() {
  ari.events.on('ChannelCreated', (e) => onCreated(e.channel).catch((x) => console.error('[track] create', x.message)));
  ari.events.on('ChannelDestroyed', (e) => onDestroyed(e.channel).catch((x) => console.error('[track] destroy', x.message)));
  ari.events.on('ChannelUserevent', (e) => {
    if (e.eventname !== 'SIPDIST_END') return;
    saveCall(e.userevent || {}).catch((x) => console.error('[track] saveCall', x.message));
  });
  ari.events.on('connected', () => { reconcile().catch(() => {}); pollTrunkState().catch(() => {}); });
  ari.connect();

  refreshMeta().catch((e) => console.error('[track] meta', e.message));
  setInterval(() => refreshMeta().catch(() => {}), 30000);
  setInterval(() => reconcile().catch((e) => console.error('[track] reconcile', e.message)), 10000);
  setInterval(() => flushPeaks().catch((e) => console.error('[track] peaks', e.message)), 15000);
  setInterval(() => pollTrunkState().catch(() => {}), 20000);
  setInterval(async () => {
    if (!bus.listenerCount('snapshot')) return;
    try { bus.emit('snapshot', await snapshot()); } catch (e) { /* redis down */ }
  }, 1000);
}

module.exports = { start, bus, snapshot, refreshMeta, saveCall, onCreated, onDestroyed, disposition, today };
