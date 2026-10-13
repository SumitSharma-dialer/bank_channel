'use strict';
// Which SIP engine carries the calls: Asterisk or Kamailio. Exactly one runs; the other is stopped and disabled.
// The choice is stored in app_settings ('sip_engine'); switching is done by the root helper deploy/sipdist-engine.sh,
// which systemd starts when this app writes a request file (the app itself has no root rights).
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const cfg = require('./config');
const { q } = require('./db');

const ENGINES = { asterisk: { label: 'Asterisk', services: ['asterisk'] }, kamailio: { label: 'Kamailio', services: ['kamailio', 'rtpengine-daemon'] } };
const bus = new EventEmitter();   // 'changed' (name)
let current = 'asterisk';
let switching = null;             // { to, by, at } while a switch runs
let lastSwitch = null;            // { to, ok, message, at, by }

const name = () => current;
const label = (e = current) => ENGINES[e].label;
const applier = (e = current) => (e === 'kamailio' ? require('./kamailio/apply') : require('./asterisk/apply'));
// write + reload the config of the engine in use (every trunk / process / DID change ends here)
const apply = (reason, opts) => applier().apply(reason, opts);
const status = () => applier().status();

async function load() {
  try {
    const r = await q(`SELECT value FROM app_settings WHERE key = 'sip_engine'`);
    if (r.rows[0] && ENGINES[r.rows[0].value]) current = r.rows[0].value;
  } catch (e) { console.warn('[engine] app_settings not readable (run npm run db:init) — using asterisk:', e.message); }
  console.log(`[engine] SIP engine: ${current}`);
  return current;
}

const isActive = (unit) => new Promise((resolve) => {
  execFile('systemctl', ['is-active', unit], { timeout: 3000 }, (err, out) => resolve(String(out || '').trim() || 'unknown'));
});
// state of every service of both engines: { asterisk: { asterisk: 'active' }, kamailio: { kamailio: 'inactive', .. } }
async function services() {
  const out = {};
  for (const [e, d] of Object.entries(ENGINES)) {
    out[e] = {};
    for (const s of d.services) out[e][s] = await isActive(s);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// hand the switch to the root helper and wait for its answer
async function runHelper(target) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const req = path.join(cfg.stateDir, 'engine.request'), resFile = path.join(cfg.stateDir, 'engine.result');
  await fs.mkdir(cfg.stateDir, { recursive: true });
  await fs.writeFile(req, `${target} ${nonce}\n`, { mode: 0o644 });
  for (let i = 0; i < 180; i++) {
    await sleep(500);
    let r; try { r = JSON.parse(await fs.readFile(resFile, 'utf8')); } catch { continue; }
    if (r.nonce === nonce) return r;
  }
  throw new Error('the engine helper did not answer in 90 s — is sipdist-engine.path enabled? (sudo bash deploy/setup.sh)');
}

// Stop the engine in use, start `target`. Live calls are dropped. Returns { ok, engine, message }.
async function switchTo(target, by) {
  if (!ENGINES[target]) throw Object.assign(new Error('unknown engine'), { status: 400 });
  if (switching) throw Object.assign(new Error(`a switch to ${label(switching.to)} is already running`), { status: 409 });
  switching = { to: target, by, at: Date.now() };
  const from = current;
  try {
    // the new engine starts with the current trunks / processes: write its files before it is started
    const pre = await applier(target).apply(`engine switch by ${by}`, { reload: false });
    if (pre.ok === false) throw new Error(`could not write the ${label(target)} config: ${pre.error}`);
    const r = await runHelper(target);
    if (!r.ok) throw new Error(r.message || 'switch failed');
    await q(`INSERT INTO app_settings(key, value) VALUES('sip_engine', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [target]);
    current = target;
    bus.emit('changed', target, from);
    // the engine read the files written above when it started: nothing to reload
    lastSwitch = { to: target, from, ok: true, message: r.message || '', at: new Date().toISOString(), by };
    console.log(`[engine] switched ${from} -> ${target} by ${by}`);
    return { ok: true, engine: current, message: r.message || '' };
  } catch (e) {
    lastSwitch = { to: target, from, ok: false, message: e.message, at: new Date().toISOString(), by };
    console.error(`[engine] switch ${from} -> ${target} failed:`, e.message);
    throw Object.assign(e, { status: e.status || 500 });
  } finally { switching = null; }
}

const info = async () => ({ engine: current, label: label(), engines: Object.fromEntries(Object.entries(ENGINES).map(([k, v]) => [k, v.label])),
  services: await services(), switching, lastSwitch, restartNeeded: !!status().restartNeeded });

module.exports = { name, label, load, apply, applier, status, services, switchTo, info, bus, ENGINES };
