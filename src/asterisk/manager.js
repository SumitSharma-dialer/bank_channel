import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { ari } from '../ari.js';
import { state, loadState } from '../state.js';
import { renderTrunks, renderProcesses, renderDialplan } from './render.js';
import { log } from '../log.js';

export const applyStatus = { lastAt: null, ok: null, error: null, reason: null, reloaded: [] };

// Reloads still owed to Asterisk (e.g. it was down when files were written)
const pending = { pjsip: true, dialplan: true };
let chain = Promise.resolve();

/** Serialised: regenerate files from DB, write the changed ones, reload Asterisk */
export function applyConfig(opts = {}) {
  const run = chain.then(() => doApply(opts));
  chain = run.catch(() => {});
  return run;
}

async function atomicWrite(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content, { mode: 0o664 });
  await rename(tmp, path);
}

async function doApply({ reason = 'change', forceReload = false } = {}) {
  applyStatus.reason = reason;
  applyStatus.lastAt = new Date().toISOString();
  try {
    await loadState();
    await mkdir(config.genDir, { recursive: true });
    const files = {
      'trunks.conf': renderTrunks(state.trunks),
      'processes.conf': renderProcesses(state.processes),
      'dialplan.conf': renderDialplan(state.processes, state.trunkById),
    };
    for (const [name, content] of Object.entries(files)) {
      const path = join(config.genDir, name);
      let current = null;
      try { current = await readFile(path, 'utf8'); } catch { /* new file */ }
      if (current !== content) {
        await atomicWrite(path, content);
        if (name === 'dialplan.conf') pending.dialplan = true; else pending.pjsip = true;
      }
    }
    if (forceReload) { pending.pjsip = true; pending.dialplan = true; }

    if (!ari.connected) {
      applyStatus.ok = true;
      applyStatus.error = 'Saved. Asterisk (ARI) is not connected - reload will run when it connects.';
      applyStatus.reloaded = [];
      return { ok: true, warning: applyStatus.error };
    }

    const reloaded = [];
    if (pending.pjsip) {
      await ari.reloadModule('res_pjsip.so');
      for (const m of ['res_pjsip_outbound_registration.so', 'res_pjsip_endpoint_identifier_ip.so']) {
        try { await ari.reloadModule(m); } catch { /* optional */ }
      }
      pending.pjsip = false;
      reloaded.push('pjsip');
    }
    if (pending.dialplan) {
      await ari.reloadModule('pbx_config.so');
      pending.dialplan = false;
      reloaded.push('dialplan');
    }
    if (reloaded.length) log.info(`Asterisk reloaded: ${reloaded.join(', ')} (${reason})`);
    Object.assign(applyStatus, { ok: true, error: null, reloaded });
    return { ok: true, reloaded };
  } catch (e) {
    log.error('Config apply failed:', e.message);
    Object.assign(applyStatus, { ok: false, error: e.message, reloaded: [] });
    return { ok: false, error: e.message };
  }
}
