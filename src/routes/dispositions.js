'use strict';
// Custom dispositions: each internal code (CHANNEL_LIMIT, SIP_DOWN, ...) can get its own display code
// (e.g. LIMIT_REACH) and label; distributor rejects can also change the SIP response the customer receives.
const router = require('express').Router();
const { q, audit } = require('../db');
const { apply } = require('../asterisk/apply');
const { SIP_CAUSE } = require('../asterisk/render');
const { Bad, wrap, str, int } = require('./util');

const CODE_RE = /^[A-Z][A-Z0-9_]{1,15}$/;

router.get('/', wrap(async (req, res) => {
  res.json({ rows: (await q('SELECT code, label, source, sip_code, sort, custom_code FROM dispositions ORDER BY sort')).rows,
    sipCodes: Object.keys(SIP_CAUSE).map(Number) });
}));

router.put('/:code', wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM dispositions WHERE code=$1', [req.params.code])).rows[0];
  if (!cur) throw new Bad('unknown disposition');
  const custom = str(req.body.custom_code, 16).toUpperCase();
  if (custom && !CODE_RE.test(custom)) throw new Bad('custom code: 2-16 chars A-Z, 0-9, _ starting with a letter');
  const label = str(req.body.label, 64) || cur.label;
  // a custom code must not look like another disposition, or reports become ambiguous
  if (custom) {
    const clash = (await q(`SELECT code FROM dispositions WHERE code<>$1 AND (code=$2 OR custom_code=$2)`, [cur.code, custom])).rows[0];
    if (clash) throw new Bad(`${custom} is already the code or display code of ${clash.code}`);
  }
  let sip = cur.sip_code;
  if (cur.source === 'distributor' && req.body.sip_code != null && req.body.sip_code !== '') {
    sip = int(req.body.sip_code, { min: 100, max: 699 });
    if (!SIP_CAUSE[sip]) throw new Bad(`SIP response must be one of ${Object.keys(SIP_CAUSE).join(', ')}`);
  }
  await q('UPDATE dispositions SET custom_code=$2, label=$3, sip_code=$4 WHERE code=$1', [cur.code, custom === cur.code ? '' : custom, label, sip]);
  await audit(req.user, 'disposition', 'disposition', cur.code, { custom_code: custom, label, sip_code: sip });
  // the SIP response is in the dialplan: re-render and reload
  const result = sip !== cur.sip_code ? await apply(`disposition ${cur.code} -> ${sip}`) : null;
  res.json({ ok: true, apply: result });
}));

module.exports = router;
