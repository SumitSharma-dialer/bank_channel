'use strict';
const router = require('express').Router();
const { execFile } = require('child_process');
const { q, audit } = require('../db');
const redis = require('../redis');
const ari = require('../ari');
const engine = require('../engine');
const auth = require('../auth');
const { rpc } = require('../kamailio/rpc');
const tracker = require('../tracker');
const { Bad, wrap, int } = require('./util');

router.get('/health', wrap(async (req, res) => {
  const kam = engine.name() === 'kamailio';
  const out = { engine: engine.name(), engineLabel: engine.label(), asterisk: null, ari: tracker.connected(), db: false, redis: false, apply: engine.status() };
  try {
    if (kam) out.asterisk = { version: String(await rpc('core.version')).trim() };
    else { const i = await ari.info(); out.asterisk = { version: i.system && i.system.version, uptime: i.status && i.status.startup_time }; }
  } catch (e) { out.asterisk = { error: e.message }; }
  try { await q('SELECT 1'); out.db = true; } catch (e) { out.dbError = e.message; }
  try { out.redis = (await redis.ping()) === 'PONG'; } catch (e) { out.redisError = e.message; }
  res.json(out);
}));

// SIP engine: which one runs, state of both. Changing it is for super admins only: it stops one engine and starts
// the other, so every live call is dropped.
router.get('/engine', wrap(async (req, res) => res.json({ ...(await engine.info()), canSwitch: auth.isSuper(req.auth) })));
router.post('/engine', auth.requireSuper, wrap(async (req, res) => {
  const target = String(req.body.engine || '');
  if (!engine.ENGINES[target]) throw new Bad('engine must be asterisk or kamailio');
  if (req.body.confirm !== true) throw new Bad('confirm the switch: live calls are dropped');
  const from = engine.name();
  let r;
  try { r = await engine.switchTo(target, req.user); }
  catch (e) {
    await audit(req.user, 'engine_switch_failed', 'system', null, { from, to: target, error: e.message });
    throw e;
  }
  await audit(req.user, from === target ? 'engine_restart' : 'engine_switch', 'system', null, { from, to: target });
  await tracker.refreshMeta();
  res.json({ ...r, info: await engine.info() });
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
  res.json(await engine.apply('manual re-apply', { force: true }));
}));

router.get('/config-preview', wrap(async (req, res) => {
  const a = engine.applier();
  res.json(await (a.preview ? a.preview() : a.renderAll()));
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
// the same views on Kamailio: JSON-RPC commands
const KAM_CMDS = {
  endpoints: ['dispatcher.list'],
  registrations: ['uac.reg_dump'],
  contacts: ['ul.dump'],
  groups: ['dlg.profile_list', ['sdproc']],
  channels: ['dlg.briefing'],
  channelstats: ['stats.fetch', ['dialog:', 'tmx:', 'sl:', 'core:rcv_requests', 'core:rcv_replies']],
  transports: ['corex.list_sockets'],
  qualify: ['dispatcher.list'],
  rtp: ['rtpengine.show', ['all']],
};
router.get('/cli/:what', wrap(async (req, res) => {
  if (engine.name() === 'kamailio') {
    const c = KAM_CMDS[req.params.what];
    if (!c) throw new Bad('unknown command');
    const cmd = `kamailio RPC: ${c[0]}${c[1] ? ' ' + c[1].join(' ') : ''}`;
    try { res.json({ cmd, output: JSON.stringify(await rpc(c[0], c[1]), null, 1) }); }
    catch (e) { res.json({ cmd, output: `error: ${e.message}` }); }
    return;
  }
  const cmd = CMDS[req.params.what];
  if (!cmd) throw new Bad('unknown command');
  execFile('asterisk', ['-rx', cmd], { timeout: 5000, maxBuffer: 2 << 20 }, (err, stdout, stderr) => {
    res.json({ cmd, output: err ? `error: ${err.message}\n${stderr || ''}` : stdout });
  });
}));

module.exports = router;
