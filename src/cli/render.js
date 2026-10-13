'use strict';
// node --env-file=.env src/cli/render.js [asterisk|kamailio]  — print the config the app would write for that engine
// (default: the engine in use)
const engine = require('../engine');
const { pool } = require('../db');

(async () => {
  const e = ['asterisk', 'kamailio'].includes(process.argv[2]) ? process.argv[2] : await engine.load();
  const files = await engine.applier(e).renderAll();
  for (const [name, text] of Object.entries(files)) console.log(`\n######## ${name}\n${text}`);
  await pool.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
