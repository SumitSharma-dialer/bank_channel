'use strict';
// JSON-RPC to Kamailio (jsonrpcs over xhttp on 127.0.0.1): reloads and status views.
const crypto = require('crypto');
const cfg = require('../config');

// shared key checked by sipdist.lua; derived from secrets only this app and data.lua know
const key = crypto.createHash('sha256').update(`kam-rpc:${cfg.db.password}:${cfg.redisUrl}`).digest('hex').slice(0, 32);

async function rpc(method, params) {
  const res = await fetch(`http://127.0.0.1:${cfg.kamailio.rpcPort}/RPC`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SD-Key': key },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(4000),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`Kamailio RPC ${method} -> ${res.status} ${text.slice(0, 120)}`); }
  if (j.error) {
    const err = new Error(`Kamailio RPC ${method}: ${j.error.message || JSON.stringify(j.error)}`);
    err.code = j.error.code;
    throw err;
  }
  return j.result;
}

// true when Kamailio answers
const alive = () => rpc('core.version').then(() => true, () => false);

module.exports = { rpc, alive, key };
