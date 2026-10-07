import { redis, K } from './redis.js';
import { state, endpointName } from './state.js';
import { ari } from './ari.js';
import { hitRate } from './tracker.js';
import { dateKey } from './util.js';
import { log } from './log.js';

/** Endpoint registration/qualify state from Asterisk, refreshed every 10s */
export const endpointState = new Map();
async function pollEndpoints() {
  if (!ari.connected) { endpointState.clear(); return; }
  try {
    const list = await ari.pjsipEndpoints();
    endpointState.clear();
    for (const e of list) endpointState.set(e.resource, e.state);
  } catch (e) { log.warn('endpoint poll failed:', e.message); }
}
export function startEndpointPoller() {
  setInterval(pollEndpoints, 10000);
  ari.on('connected', pollEndpoints);
}

const n = (v) => Number(v) || 0;

export async function snapshot() {
  const day = dateKey();
  const res = await redis.pipeline()
    .hgetall(K.live('process')).hgetall(K.live('trunk'))
    .hgetall(K.peak(day, 'process')).hgetall(K.peak(day, 'trunk'))
    .hgetall(K.hits(day, 'process')).hgetall(K.hits(day, 'trunk'))
    .exec();
  const [lp, lt, pp, pt, hp, ht] = res.map(([, v]) => v || {});

  const allocated = new Map();
  for (const p of state.processes) {
    if (p.active && p.trunk_id) allocated.set(p.trunk_id, (allocated.get(p.trunk_id) || 0) + p.channel_limit);
  }

  const trunks = state.trunks.map((t) => ({
    id: t.id, code: t.code, name: t.name, active: t.active, host: t.host,
    total: t.total_channels, live: n(lt[t.code]), peak: n(pt[t.code]), hits: n(ht[t.code]),
    hpm: hitRate('trunk', t.code, 60000), hps: hitRate('trunk', t.code, 1500),
    allocated: allocated.get(t.id) || 0,
    status: endpointState.get(endpointName.trunk(t.code)) || (t.active ? 'unknown' : 'disabled'),
  }));

  const processes = state.processes.map((p) => {
    const t = p.trunk_id ? state.trunkById.get(p.trunk_id) : null;
    return {
      id: p.id, code: p.code, name: p.name, active: p.active, limit: p.channel_limit,
      trunk: t ? { id: t.id, code: t.code, name: t.name } : null,
      live: n(lp[p.code]), peak: n(pp[p.code]), hits: n(hp[p.code]),
      hpm: hitRate('process', p.code, 60000), hps: hitRate('process', p.code, 1500),
      status: endpointState.get(endpointName.process(p.code)) || 'unknown',
    };
  });

  const sum = (arr, k) => arr.reduce((a, x) => a + x[k], 0);
  return {
    ts: Date.now(),
    ari: ari.connected,
    trunks,
    processes,
    totals: {
      live: sum(processes, 'live'),
      trunkLive: sum(trunks, 'live'),
      capacity: trunks.filter((t) => t.active).reduce((a, t) => a + t.total, 0),
      hpm: sum(processes, 'hpm'),
      hitsToday: sum(processes, 'hits'),
    },
  };
}
