'use strict';
// DB -> files in /etc/asterisk/sipdist -> ARI module reload.
// This is THE integration point between the UI and Asterisk.
const fs = require('fs/promises');
const path = require('path');
const cfg = require('../config');
const { q } = require('../db');
const ari = require('../ari');
const { renderTrunks, renderProcesses, renderDialplan } = require('./render');

let chain = Promise.resolve();
let last = { at: null, ok: null, error: null, reloaded: [] };

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text, { mode: 0o640 });
  await fs.rename(tmp, file);
}

async function loadRows() {
  const trunks = (await q('SELECT * FROM trunks ORDER BY name')).rows;
  const processes = (await q('SELECT * FROM processes ORDER BY code')).rows;
  const ranges = (await q('SELECT * FROM trunk_did_ranges ORDER BY trunk_id, first_did')).rows;
  for (const t of trunks) t.did_ranges = ranges.filter((r) => r.trunk_id === t.id);
  // SIP response per distributor reject, edited on the Dispositions page
  const rejectCodes = {};
  for (const d of (await q(`SELECT code, sip_code FROM dispositions WHERE source='distributor'`)).rows) rejectCodes[d.code] = d.sip_code;
  return { trunks, processes, rejectCodes };
}

async function renderAll() {
  const { trunks, processes, rejectCodes } = await loadRows();
  return {
    'trunks.conf': renderTrunks(trunks),
    'processes.conf': renderProcesses(processes),
    'dialplan.conf': renderDialplan(processes, trunks, cfg.statsTz, `http://127.0.0.1:${cfg.http.port}/internal/did-route`, rejectCodes),
  };
}

async function doApply(reason) {
  const files = await renderAll();
  await fs.mkdir(cfg.asterisk.confDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeAtomic(path.join(cfg.asterisk.confDir, name), text);
  }
  const reloaded = [];
  if (cfg.asterisk.reload) {
    // pjsip: endpoints, auths, aors, identifies, registrations. pbx_config: dialplan.
    for (const mod of ['res_pjsip.so', 'res_pjsip_outbound_registration.so', 'pbx_config.so']) {
      try { await ari.reloadModule(mod); reloaded.push(mod); }
      catch (e) { if (mod !== 'res_pjsip_outbound_registration.so') throw e; }
    }
  }
  last = { at: new Date().toISOString(), ok: true, error: null, reloaded, reason };
  console.log(`[apply] ${reason}: wrote ${Object.keys(files).join(', ')}; reloaded ${reloaded.join(', ') || 'nothing'}`);
  return last;
}

// Serialised: two UI saves at once never interleave file writes / reloads.
function apply(reason = 'manual') {
  const p = chain.then(() => doApply(reason)).catch((e) => {
    last = { at: new Date().toISOString(), ok: false, error: e.message, reloaded: [], reason };
    console.error('[apply] failed:', e.message);
    return last;
  });
  chain = p;
  return p;
}

module.exports = { apply, renderAll, status: () => last };
