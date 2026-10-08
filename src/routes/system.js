'use strict';
const router = require('express').Router();
const { execFile } = require('child_process');
const { q, audit } = require('../db');
const redis = require('../redis');
const ari = require('../ari');
const applier = require('../asterisk/apply');
const tracker = require('../tracker');
const { hashPassword, verifyPassword } = require('../auth');
const { Bad, wrap, str, int } = require('./util');

router.get('/health', wrap(async (req, res) => {
  const out = { asterisk: null, ari: ari.connected, db: false, redis: false, apply: applier.status() };
  try { const i = await ari.info(); out.asterisk = { version: i.system && i.system.version, uptime: i.status && i.status.startup_time }; }
  catch (e) { out.asterisk = { error: e.message }; }
  try { await q('SELECT 1'); out.db = true; } catch (e) { out.dbError = e.message; }
  try { out.redis = (await redis.ping()) === 'PONG'; } catch (e) { out.redisError = e.message; }
  res.json(out);
}));

// CPU / RAM / storage of this server (System page, refreshed every 5 s)
router.get('/resources', wrap(async (req, res) => res.json(await require('../sysinfo').collect())));
// last `hours` (max 5 days) of the per-minute samples, for the System page graphs
router.get('/resources/history', wrap(async (req, res) => {
  const sys = require('../sysinfo');
  const hours = int(req.query.hours, { min: 1, max: sys.HISTORY_DAYS * 24, def: sys.HISTORY_DAYS * 24 });
  res.json({ hours, points: await sys.history(q, hours) });
}));

router.post('/apply', wrap(async (req, res) => {
  await audit(req.user, 'apply', 'system', null, null);
  await tracker.refreshMeta();
  res.json(await applier.apply('manual re-apply'));
}));

router.get('/config-preview', wrap(async (req, res) => {
  res.json(await applier.renderAll());
}));

// Read-only Asterisk CLI views for the System page
const CMDS = {
  endpoints: 'pjsip show endpoints',
  registrations: 'pjsip show registrations',
  contacts: 'pjsip show contacts',
  groups: 'group show channels',
  channels: 'core show channels concise',
  channelstats: 'pjsip show channelstats',
  transports: 'pjsip show transports',
  qualify: 'pjsip show aors',
  rtp: 'rtp show settings',
};
router.get('/cli/:what', wrap(async (req, res) => {
  const cmd = CMDS[req.params.what];
  if (!cmd) throw new Bad('unknown command');
  execFile('asterisk', ['-rx', cmd], { timeout: 5000, maxBuffer: 2 << 20 }, (err, stdout, stderr) => {
    res.json({ cmd, output: err ? `error: ${err.message}\n${stderr || ''}` : stdout });
  });
}));

router.get('/audit', wrap(async (req, res) => {
  const limit = int(req.query.limit, { min: 1, max: 500, def: 100 });
  res.json((await q(`SELECT * FROM audit_log ORDER BY at DESC LIMIT ${limit}`)).rows);
}));

router.post('/password', wrap(async (req, res) => {
  const cur = str(req.body.current, 200), next = str(req.body.next, 200);
  if (next.length < 8) throw new Bad('new password must be at least 8 characters');
  const a = (await q('SELECT * FROM admins WHERE username=$1', [req.user])).rows[0];
  if (!a || !verifyPassword(cur, a.pass_hash)) throw new Bad('current password is wrong');
  await q('UPDATE admins SET pass_hash=$1 WHERE id=$2', [hashPassword(next), a.id]);
  await audit(req.user, 'password', 'admin', a.id, null);
  res.json({ ok: true });
}));

module.exports = router;
