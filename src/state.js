import { q } from './db.js';

/** In-memory cache of trunks/processes, rebuilt after every change */
export const state = {
  trunks: [],
  processes: [],
  trunkById: new Map(),
  processById: new Map(),
  trunkByCode: new Map(),
  processByCode: new Map(),
  byEndpoint: new Map(), // endpoint name -> { type, id, code }
};

export const endpointName = {
  trunk: (code) => `t_${code}`,
  process: (code) => `p_${code}`,
};

export async function loadState() {
  const trunks = (await q('SELECT * FROM trunks ORDER BY name')).rows;
  const processes = (await q('SELECT * FROM processes ORDER BY name')).rows;
  state.trunks = trunks;
  state.processes = processes;
  state.trunkById = new Map(trunks.map((t) => [t.id, t]));
  state.processById = new Map(processes.map((p) => [p.id, p]));
  state.trunkByCode = new Map(trunks.map((t) => [t.code, t]));
  state.processByCode = new Map(processes.map((p) => [p.code, p]));
  const be = new Map();
  for (const t of trunks) be.set(endpointName.trunk(t.code), { type: 'trunk', id: t.id, code: t.code });
  for (const p of processes) be.set(endpointName.process(p.code), { type: 'process', id: p.id, code: p.code });
  state.byEndpoint = be;
}
