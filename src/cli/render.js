'use strict';
// node --env-file=.env src/cli/render.js   — print what would be written to /etc/asterisk/sipdist
const { renderAll } = require('../asterisk/apply');
const { pool } = require('../db');

(async () => {
  const files = await renderAll();
  for (const [name, text] of Object.entries(files)) console.log(`\n######## ${name}\n${text}`);
  await pool.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
