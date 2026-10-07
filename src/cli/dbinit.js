'use strict';
// node --env-file=.env src/cli/dbinit.js  — create/upgrade tables and the first admin
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { ensureAdmin } = require('../auth');

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8'));
  console.log('schema ok');
  await ensureAdmin();
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
