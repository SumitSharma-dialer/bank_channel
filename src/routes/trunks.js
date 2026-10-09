'use strict';
const router = require('express').Router();
const { q, pool, audit } = require('../db');
const { apply } = require('../asterisk/apply');
const tracker = require('../tracker');
const { Bad, wrap, str, int, bool, name, diff, HOST_RE, codecs, safeText } = require('./util');

const PUBLIC_COLS = `t.id,t.name,t.description,t.host,t.port,t.transport,t.username,
  (t.password IS NOT NULL AND t.password<>'') AS has_password,t.register,t.from_user,t.from_domain,
  t.max_channels,t.cps,t.prefix,t.cli_prefix,t.strip_digits,t.codecs,t.dial_timeout,t.allow_inbound,t.active,t.created_at,t.updated_at`;

function parse(b, existing) {
  // fields not in the form (strip_digits, codecs, dial_timeout) or not sent by an API client = keep current value
  for (const k of ['prefix', 'cli_prefix', 'strip_digits', 'codecs', 'dial_timeout']) if (b[k] === undefined && existing) b = { ...b, [k]: existing[k] };
  const host = str(b.host);
  if (!HOST_RE.test(host)) throw new Bad('host must be an IP or hostname');
  const prefix = str(b.prefix, 32);
  if (!/^\+?[0-9]*$/.test(prefix)) throw new Bad('prefix may only contain digits (and a leading +)');
  const cliPrefix = str(b.cli_prefix, 32);
  if (!/^\+?[0-9]*$/.test(cliPrefix)) throw new Bad('CLI prefix may only contain digits (and a leading +)');
  return {
    name: name(b.name, 'Trunk name'),
    description: safeText(b.description, 200),
    host,
    port: int(b.port, { min: 1, max: 65535, def: 5060 }),
    transport: b.transport === 'tcp' ? 'tcp' : 'udp',
    username: safeText(b.username, 128) || null,
    // blank password on edit = keep current
    password: b.password ? safeText(b.password, 128) : (existing ? existing.password : null),
    register: bool(b.register),
    from_user: safeText(b.from_user, 128) || null,
    from_domain: safeText(b.from_domain, 255) || null,
    max_channels: int(b.max_channels, { min: 0, max: 100000, def: 30 }),
    cps: int(b.cps, { min: 0, max: 1000, def: existing ? existing.cps : 0 }),
    prefix,
    cli_prefix: cliPrefix,
    strip_digits: int(b.strip_digits, { min: 0, max: 10, def: 0 }),
    codecs: codecs(b.codecs),
    dial_timeout: int(b.dial_timeout, { min: 5, max: 300, def: 60 }),
    allow_inbound: b.allow_inbound === undefined ? (existing ? existing.allow_inbound : true) : bool(b.allow_inbound),
    active: b.active === undefined ? true : bool(b.active),
  };
}

const RANGE_MAX = 1000000;
const DID_RE = /^[0-9]{4,15}$/;
const RANGES_SQL = `(SELECT coalesce(json_agg(json_build_object('id',r.id,'first_did',r.first_did,'last_did',r.last_did,
    'process_id',r.process_id,'process_code',p.code,'use_as_cli',r.use_as_cli,'note',r.note) ORDER BY r.first_did),'[]')
  FROM trunk_did_ranges r LEFT JOIN processes p ON p.id=r.process_id WHERE r.trunk_id=t.id) AS did_ranges`;

// did_ranges: [{ first_did, last_did?, process_id?, use_as_cli?, note? }] — a single DID is first = last
async function parseRanges(list, trunkId) {
  if (list === undefined) return undefined;            // not sent = keep current ranges
  if (!Array.isArray(list)) throw new Bad('did_ranges must be a list');
  if (list.length > 5000) throw new Bad('at most 5000 DID ranges per trunk');
  const out = list.map((r, i) => {
    const first = str(r.first_did, 20).replace(/^\+/, '');
    const last = str(r.last_did, 20).replace(/^\+/, '') || first;
    const at = `DID range ${i + 1} (${first || '?'}–${last || '?'})`;
    if (!DID_RE.test(first) || !DID_RE.test(last)) throw new Bad(`${at}: numbers must be 4–15 digits`);
    if (first.length !== last.length) throw new Bad(`${at}: first and last must have the same number of digits`);
    if (BigInt(first) > BigInt(last)) throw new Bad(`${at}: first is bigger than last`);
    if (BigInt(last) - BigInt(first) + 1n > BigInt(RANGE_MAX)) throw new Bad(`${at}: max ${RANGE_MAX.toLocaleString()} numbers per range`);
    return { first_did: first, last_did: last, process_id: r.process_id ? int(r.process_id, { min: 1 }) : null,
      use_as_cli: r.use_as_cli === undefined ? true : bool(r.use_as_cli), note: safeText(r.note, 128) || null };
  });
  const others = (await q('SELECT r.first_did, r.last_did, t.name FROM trunk_did_ranges r JOIN trunks t ON t.id=r.trunk_id WHERE r.trunk_id<>$1', [trunkId || 0])).rows;
  const clash = (a, b) => a.first_did.length === b.first_did.length && BigInt(a.first_did) <= BigInt(b.last_did) && BigInt(b.first_did) <= BigInt(a.last_did);
  out.forEach((a, i) => {
    const mine = out.slice(i + 1).find((b) => clash(a, b));
    if (mine) throw new Bad(`DID ranges ${a.first_did}–${a.last_did} and ${mine.first_did}–${mine.last_did} overlap`);
    const o = others.find((b) => clash(a, b));
    if (o) throw new Bad(`DID range ${a.first_did}–${a.last_did} overlaps ${o.first_did}–${o.last_did} on trunk ${o.name}`);
  });
  const ids = [...new Set(out.map((r) => r.process_id).filter(Boolean))];
  if (ids.length) {
    const procs = (await q('SELECT id, code, trunk_id, auth_type, allowed_ips FROM processes WHERE id = ANY($1)', [ids])).rows;
    for (const id of ids) {
      const p = procs.find((x) => x.id === id);
      if (!p) throw new Bad(`process ${id} does not exist`);
      if (!trunkId || p.trunk_id !== trunkId) throw new Bad(`process ${p.code} is not on this trunk — DIDs can only go to processes using this trunk`);
      if (p.auth_type === 'ip' && !p.allowed_ips.split(',').some((x) => x && !x.includes('/')))
        throw new Bad(`process ${p.code} only has IP ranges (CIDR) — add a fixed customer IP so inbound calls can be sent to it`);
    }
  }
  return out;
}

async function saveTrunk(id, t, ranges) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const cols = Object.keys(t);
    if (id) {
      await c.query(`UPDATE trunks SET ${cols.map((k, i) => `${k}=$${i + 1}`)}, updated_at=now() WHERE id=$${cols.length + 1}`, [...Object.values(t), id]);
    } else {
      id = (await c.query(`INSERT INTO trunks(${cols}) VALUES(${cols.map((_, i) => '$' + (i + 1))}) RETURNING id`, Object.values(t))).rows[0].id;
    }
    if (ranges) {
      await c.query('DELETE FROM trunk_did_ranges WHERE trunk_id=$1', [id]);
      for (const r of ranges) {
        await c.query('INSERT INTO trunk_did_ranges(trunk_id,first_did,last_did,process_id,use_as_cli,note) VALUES($1,$2,$3,$4,$5,$6)',
          [id, r.first_did, r.last_did, r.process_id, r.use_as_cli, r.note]);
      }
    }
    await c.query('COMMIT');
    return id;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

async function changed(req, action, id, details) {
  await audit(req.user, action, 'trunk', id, details);
  await tracker.refreshMeta();
  return apply(`trunk ${action}`);
}

router.get('/', wrap(async (req, res) => {
  const { rows } = await q(`SELECT ${PUBLIC_COLS},
      (SELECT count(*)::int FROM processes p WHERE p.trunk_id=t.id) AS process_count,
      (SELECT coalesce(sum(channel_limit),0)::int FROM processes p WHERE p.trunk_id=t.id AND p.active) AS assigned_channels,
      ${RANGES_SQL}
    FROM trunks t ORDER BY t.name`);
  res.json(rows);
}));

router.post('/', wrap(async (req, res) => {
  const t = parse(req.body);
  const ranges = await parseRanges(req.body.did_ranges, null);
  const id = await saveTrunk(null, t, ranges);
  const result = await changed(req, 'create', id, { name: t.name, did_ranges: ranges ? ranges.length : 0 });
  res.status(201).json({ id, apply: result });
}));

router.put('/:id', wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const cur = (await q('SELECT * FROM trunks WHERE id=$1', [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not found' });
  const t = parse(req.body, cur);
  const ranges = await parseRanges(req.body.did_ranges, id);
  await saveTrunk(id, t, ranges);
  res.json({ apply: await changed(req, 'update', id, { name: t.name, changes: diff(cur, t), ...(ranges ? { did_ranges: ranges.length } : {}) }) });
}));

router.post('/:id/active', wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const active = bool(req.body.active);
  const r = await q('UPDATE trunks SET active=$1, updated_at=now() WHERE id=$2 RETURNING name', [active, id]);
  if (!r.rowCount) return res.status(404).json({ error: 'not found' });
  res.json({ apply: await changed(req, active ? 'activate' : 'deactivate', id, { name: r.rows[0].name }) });
}));

router.delete('/:id', wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const r = await q('DELETE FROM trunks WHERE id=$1 RETURNING name', [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'not found' });
  res.json({ apply: await changed(req, 'delete', id, { name: r.rows[0].name }) });
}));

module.exports = router;
