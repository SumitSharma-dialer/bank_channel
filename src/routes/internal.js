'use strict';
// Endpoints for Asterisk on this host only (dialplan CURL), no admin login.
const router = require('express').Router();
const { q } = require('../db');
const { wrap } = require('./util');

const LOCAL = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
router.use((req, res, next) => (LOCAL.test(req.socket.remoteAddress || '') ? next() : res.status(403).end()));

// Inbound call to <did> from <from>: which process gets it? Plain-text process code, '' = none
// (the dialplan then uses the process the DID range is assigned to).
//   1. process that last called this number with this DID as caller ID (callback)
//   2. process that last used this DID as caller ID
router.get('/did-route', wrap(async (req, res) => {
  const did = String(req.query.did || '').replace(/[^0-9]/g, '').slice(0, 20);
  const from = String(req.query.from || '').replace(/[^0-9]/g, '').slice(0, 20);
  let code = '';
  if (did) {
    const base = `SELECT c.process_code FROM calls c JOIN processes p ON p.code = c.process_code
      WHERE c.direction = 'out' AND c.did = $1 AND c.start_time > now() - interval '90 days'`;
    if (from.length >= 6) {
      code = (await q(`${base} AND right(c.dialed, 10) = right($2, 10) ORDER BY c.start_time DESC LIMIT 1`, [did, from])).rows[0]?.process_code || '';
    }
    if (!code) code = (await q(`${base} ORDER BY c.start_time DESC LIMIT 1`, [did])).rows[0]?.process_code || '';
  }
  res.type('text/plain').send(code);
}));

module.exports = router;
