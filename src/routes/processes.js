'use strict';
const router = require('express').Router();
const cfg = require('../config');
const { q, pool, audit } = require('../db');
const { apply } = require('../asterisk/apply');
const { peerConfig } = require('../asterisk/render');
const tracker = require('../tracker');
const { Bad, wrap, str, int, bool, name, IP_RE, codecs, safeText, genPassword, suggestCli } = require('./util');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
// working time: falsy/off = any time; else { days: [...], from: 'HH:MM', to: 'HH:MM' } (to < from = past midnight)
function hours(h, what) {
  if (!h || h.on === false) return null;
  const days = DAYS.filter((d) => Array.isArray(h.days) && h.days.includes(d));
  if (!days.length) throw new Bad(`${what} working time: pick at least one day`);
  const from = str(h.from, 5), to = str(h.to, 5);
  if (!HHMM.test(from) || !HHMM.test(to)) throw new Bad(`${what} working time: times must be HH:MM`);
  if (from === to) throw new Bad(`${what} working time: start and end are the same`);
  return { days, from, to };
}

async function parse(b, id) {
  const auth_type = 'ip';   // customers are identified by their server IP only
  const code = name(b.code, 'Process code');
  const p = {
    code,
    name: safeText(b.name, 128) || code,
    trunk_id: b.trunk_id ? int(b.trunk_id, { min: 1 }) : null,
    channel_limit: int(b.channel_limit, { min: 1, max: 100000 }),
    auth_type,
    sip_username: null,
    sip_password: null,
    allowed_ips: '',
    cli_mode: 'dummy',   // dummy_cli = the number the client dials; caller ID always comes from X-DID
    dummy_cli: str(b.dummy_cli, 32).replace(/[^0-9+]/g, ''),
    codecs: codecs(b.codecs),
    active: b.active === undefined ? true : bool(b.active),
    notes: str(b.notes, 1000) || null,
    allow_outbound: b.allow_outbound === undefined ? true : bool(b.allow_outbound),
    allow_inbound: b.allow_inbound === undefined ? true : bool(b.allow_inbound),
    out_hours: JSON.stringify(hours(b.out_hours, 'Outbound')),
    in_hours: JSON.stringify(hours(b.in_hours, 'Inbound')),
  };
  if (!/^[0-9]{4,20}$/.test(p.dummy_cli)) throw new Bad('dummy number: 4–20 digits (the number the client dials)');

  const list = str(b.allowed_ips, 2000).split(/[\s,]+/).filter(Boolean);
  for (const ip of list) if (!IP_RE.test(ip)) throw new Bad(`bad IP/CIDR: ${ip}`);
  p.allowed_ips = list.join(',');
  if (auth_type === 'ip') {
    if (!list.length) throw new Bad('IP authentication needs at least one customer IP');
    const others = await q(`SELECT code, allowed_ips FROM processes WHERE auth_type='ip' AND id<>$1`, [id || 0]);
    for (const o of others.rows) {
      const clash = o.allowed_ips.split(',').find((x) => list.includes(x));
      if (clash) throw new Bad(`IP ${clash} is already used by process ${o.code} — each IP must identify one process`);
    }
  }
  if (p.trunk_id) {
    const t = await q('SELECT id FROM trunks WHERE id=$1', [p.trunk_id]);
    if (!t.rowCount) throw new Bad('selected trunk does not exist');
  }
  if (p.cli_mode === 'trunk_did') {
    const r = p.trunk_id ? await q('SELECT 1 FROM trunk_did_ranges WHERE trunk_id=$1 AND use_as_cli LIMIT 1', [p.trunk_id]) : { rowCount: 0 };
    if (!r.rowCount) throw new Bad('caller ID from trunk DIDs needs a trunk with at least one caller-ID DID range');
  }
  return p;
}

// dids: ['1240', '1245-1250', ...] -> single DIDs / runs on the process's trunk that are free (or already this
// process's) become its inbound DIDs; the rest of its DIDs are freed. Not sent = keep current assignment.
const DID_RE = /^[0-9]{4,15}$/;
const fmtDid = (n, len) => n.toString().padStart(len, '0');
const didAt = (len, lo, hi) => (lo === hi ? fmtDid(lo, len) : `${fmtDid(lo, len)}–${fmtDid(hi, len)}`);

function parseDids(list, p) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw new Bad('dids must be a list');
  if (list.length > 10000) throw new Bad('too many DID entries — use runs like 1240-1249');
  const segs = list.map((x) => {
    const [a, b = a, extra] = str(x, 40).replace(/[\s+]/g, '').split('-');
    if (extra !== undefined || !DID_RE.test(a) || !DID_RE.test(b)) throw new Bad(`bad DID "${str(x, 40)}" — use 4–15 digits or a run like 1240-1249`);
    if (a.length !== b.length) throw new Bad(`DID run ${a}-${b}: both ends need the same number of digits`);
    if (BigInt(a) > BigInt(b)) throw new Bad(`DID run ${a}-${b}: first is bigger than last`);
    return { len: a.length, lo: BigInt(a), hi: BigInt(b) };
  });
  if (!segs.length) return segs;
  if (!p.trunk_id) throw new Bad('pick a trunk before assigning DIDs');
  if (p.auth_type === 'ip' && !p.allowed_ips.split(',').some((x) => x && !x.includes('/')))
    throw new Bad('inbound DIDs need a fixed customer IP (not only CIDR ranges) to send calls to');
  // sort + merge overlapping / adjacent runs
  segs.sort((x, y) => x.len - y.len || (x.lo < y.lo ? -1 : x.lo > y.lo ? 1 : 0));
  return segs.reduce((out, s) => {
    const l = out[out.length - 1];
    if (l && l.len === s.len && s.lo <= l.hi + 1n) { if (s.hi > l.hi) l.hi = s.hi; } else out.push({ ...s });
    return out;
  }, []);
}

// Give process `pid` exactly the DIDs in `segs` on trunk `trunkId`: DID ranges are split where ownership changes
// and adjacent ranges with the same owner / caller-ID flag / note are merged again. Runs inside the caller's transaction.
async function assignDids(c, pid, trunkId, segs) {
  const rows = (await c.query(`SELECT r.first_did, r.last_did, r.process_id, r.use_as_cli, r.note, o.code
    FROM trunk_did_ranges r LEFT JOIN processes o ON o.id=r.process_id WHERE r.trunk_id=$1 FOR UPDATE OF r`, [trunkId])).rows
    .map((r) => ({ ...r, len: r.first_did.length, lo: BigInt(r.first_did), hi: BigInt(r.last_did) }));
  const over = (a, b) => a.len === b.len && a.lo <= b.hi && b.lo <= a.hi;
  for (const s of segs) {
    let covered = 0n;
    for (const r of rows.filter((x) => over(x, s))) {
      const lo = r.lo > s.lo ? r.lo : s.lo, hi = r.hi < s.hi ? r.hi : s.hi;
      if (r.process_id && r.process_id !== pid) throw new Bad(`DID ${didAt(s.len, lo, hi)} is already assigned to process ${r.code}`);
      covered += hi - lo + 1n;
    }
    if (covered !== s.hi - s.lo + 1n) throw new Bad(`DID ${didAt(s.len, s.lo, s.hi)} is not (all) on the selected trunk`);
  }
  // cut every free / own range at the run edges; owner = pid inside a run, else free
  const pieces = [];
  for (const r of rows) {
    if (r.process_id && r.process_id !== pid) { pieces.push(r); continue; }
    let at = r.lo;
    for (const s of segs.filter((x) => over(x, r))) {
      const lo = s.lo > r.lo ? s.lo : r.lo, hi = s.hi < r.hi ? s.hi : r.hi;
      if (lo > at) pieces.push({ ...r, lo: at, hi: lo - 1n, process_id: null });
      pieces.push({ ...r, lo, hi, process_id: pid });
      at = hi + 1n;
    }
    if (at <= r.hi) pieces.push({ ...r, lo: at, hi: r.hi, process_id: null });
  }
  pieces.sort((x, y) => x.len - y.len || (x.lo < y.lo ? -1 : 1));
  const merged = pieces.reduce((out, r) => {
    const l = out[out.length - 1];
    if (l && l.len === r.len && l.hi + 1n === r.lo && l.process_id === r.process_id && l.use_as_cli === r.use_as_cli && l.note === r.note) l.hi = r.hi;
    else out.push({ ...r });
    return out;
  }, []);
  const key = (list) => list.map((r) => [r.len, r.lo, r.hi, r.process_id, r.use_as_cli, r.note].join('|')).sort().join(';');
  if (key(merged) === key(rows)) return;
  await c.query('DELETE FROM trunk_did_ranges WHERE trunk_id=$1', [trunkId]);
  for (const r of merged) {
    await c.query('INSERT INTO trunk_did_ranges(trunk_id,first_did,last_did,process_id,use_as_cli,note) VALUES($1,$2,$3,$4,$5,$6)',
      [trunkId, fmtDid(r.lo, r.len), fmtDid(r.hi, r.len), r.process_id, r.use_as_cli, r.note]);
  }
}

// insert/update the process and its DID assignment in one transaction
async function saveProcess(id, p, dids) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const cols = Object.keys(p);
    if (id) {
      await c.query(`UPDATE processes SET ${cols.map((k, i) => `${k}=$${i + 1}`)}, updated_at=now() WHERE id=$${cols.length + 1}`, [...Object.values(p), id]);
    } else {
      id = (await c.query(`INSERT INTO processes(${cols}) VALUES(${cols.map((_, i) => '$' + (i + 1))}) RETURNING id`, Object.values(p))).rows[0].id;
    }
    // DIDs on another trunk can't stay with the process when its trunk changes
    await c.query('UPDATE trunk_did_ranges SET process_id=NULL WHERE process_id=$1 AND trunk_id IS DISTINCT FROM $2', [id, p.trunk_id]);
    if (dids && p.trunk_id) await assignDids(c, id, p.trunk_id, dids);
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') throw new Bad('code or SIP username already exists');
    throw e;
  } finally { c.release(); }
}

async function changed(req, action, id, details) {
  await audit(req.user, action, 'process', id, details);
  await tracker.refreshMeta();
  return apply(`process ${action}`);
}

router.get('/suggest', wrap(async (req, res) => {
  res.json({ dummy_cli: suggestCli(), sip_password: genPassword() });
}));

router.get('/', wrap(async (req, res) => {
  const { rows } = await q(`SELECT p.*, t.name AS trunk_name, t.active AS trunk_active, t.max_channels AS trunk_max,
      (SELECT coalesce(json_agg(CASE WHEN r.first_did=r.last_did THEN r.first_did ELSE r.first_did||'-'||r.last_did END ORDER BY r.first_did),'[]')
         FROM trunk_did_ranges r WHERE r.process_id=p.id) AS inbound_dids,
      (SELECT coalesce(sum(r.last_did::numeric - r.first_did::numeric + 1),0)::bigint
         FROM trunk_did_ranges r WHERE r.process_id=p.id) AS did_count
    FROM processes p LEFT JOIN trunks t ON t.id=p.trunk_id ORDER BY p.code`);
  res.json(rows);
}));

// last calls to the dummy number with the raw header values received -> "is the client sending headers?"
router.get('/:id/header-log', wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const p = (await q('SELECT code FROM processes WHERE id=$1', [id])).rows[0];
  if (!p) return res.status(404).json({ error: 'not found' });
  const { rows } = await q(`SELECT start_time, hdr_status, hdr_did, hdr_num, did, sent_number, disposition, bill_sec, src_ip
    FROM calls WHERE process_code=$1 AND hdr_status IS NOT NULL ORDER BY start_time DESC LIMIT 50`, [p.code]);
  res.json(rows);
}));

router.get('/:id/peer-config', wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const p = (await q('SELECT * FROM processes WHERE id=$1', [id])).rows[0];
  if (!p) return res.status(404).json({ error: 'not found' });
  const dids = (await q(`SELECT CASE WHEN first_did=last_did THEN first_did ELSE first_did||'-'||last_did END AS d
    FROM trunk_did_ranges WHERE process_id=$1 ORDER BY first_did`, [id])).rows.map((r) => r.d);
  res.json({ ...peerConfig(p, cfg.publicIp, cfg.sipPort, dids), dids, publicIp: cfg.publicIp, port: cfg.sipPort,
    username: p.sip_username, password: p.sip_password, auth_type: p.auth_type, limit: p.channel_limit });
}));

router.post('/', wrap(async (req, res) => {
  const p = await parse(req.body);
  const dids = parseDids(req.body.dids, p);
  const id = await saveProcess(null, p, dids);
  const result = await changed(req, 'create', id, { code: p.code, limit: p.channel_limit, ...(dids ? { dids: dids.map((d) => didAt(d.len, d.lo, d.hi)) } : {}) });
  res.status(201).json({ id, apply: result });
}));

router.put('/:id', wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const cur = (await q('SELECT * FROM processes WHERE id=$1', [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not found' });
  // codecs / notes are no longer in the form: not sent = keep current
  const p = await parse({ codecs: cur.codecs, notes: cur.notes, ...req.body, sip_password: req.body.sip_password || cur.sip_password }, id);
  const dids = parseDids(req.body.dids, p);
  await saveProcess(id, p, dids);
  res.json({ apply: await changed(req, 'update', id, { code: p.code, limit: p.channel_limit, was: cur.channel_limit, ...(dids ? { dids: dids.map((d) => didAt(d.len, d.lo, d.hi)) } : {}) }) });
}));

router.post('/:id/limit', wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const limit = int(req.body.channel_limit, { min: 1, max: 100000 });
  const r = await q('UPDATE processes SET channel_limit=$1, updated_at=now() WHERE id=$2 RETURNING code', [limit, id]);
  if (!r.rowCount) return res.status(404).json({ error: 'not found' });
  res.json({ apply: await changed(req, 'limit', id, { code: r.rows[0].code, limit }) });
}));

router.post('/:id/regenerate', wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const pw = genPassword();
  const r = await q(`UPDATE processes SET sip_password=$1, updated_at=now() WHERE id=$2 AND auth_type='password' RETURNING code`, [pw, id]);
  if (!r.rowCount) throw new Bad('process not found or uses IP authentication');
  res.json({ sip_password: pw, apply: await changed(req, 'regen-password', id, { code: r.rows[0].code }) });
}));

router.post('/:id/active', wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const active = bool(req.body.active);
  const r = await q('UPDATE processes SET active=$1, updated_at=now() WHERE id=$2 RETURNING code', [active, id]);
  if (!r.rowCount) return res.status(404).json({ error: 'not found' });
  res.json({ apply: await changed(req, active ? 'activate' : 'deactivate', id, { code: r.rows[0].code }) });
}));

router.delete('/:id', wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const r = await q('DELETE FROM processes WHERE id=$1 RETURNING code', [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'not found' });
  res.json({ apply: await changed(req, 'delete', id, { code: r.rows[0].code }) });
}));

module.exports = router;
