'use strict';
const { Pool } = require('pg');
const cfg = require('./config');

const pool = new Pool(cfg.db);
pool.on('error', (e) => console.error('[db] pool error', e.message));

const q = (text, params) => pool.query(text, params);

async function audit(admin, action, entity, entityId, details) {
  try {
    await q('INSERT INTO audit_log(admin,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)',
      [admin || null, action, entity || null, entityId == null ? null : String(entityId), details ? JSON.stringify(details) : null]);
  } catch (e) { console.error('[audit]', e.message); }
}

module.exports = { pool, q, audit };
