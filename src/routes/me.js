'use strict';
// The signed-in user's own account (every role): change password. Other sessions of the user are signed out.
const router = require('express').Router();
const { q, audit } = require('../db');
const { hashPassword, verifyPassword, revoke } = require('../auth');
const { Bad, wrap, str } = require('./util');

router.post('/password', wrap(async (req, res) => {
  const cur = str(req.body.current, 200), next = str(req.body.next, 200);
  if (next.length < 8) throw new Bad('new password must be at least 8 characters');
  const a = (await q('SELECT * FROM admins WHERE username=$1', [req.user])).rows[0];
  if (!a || !verifyPassword(cur, a.pass_hash)) throw new Bad('current password is wrong');
  await q('UPDATE admins SET pass_hash=$1 WHERE id=$2', [hashPassword(next), a.id]);
  const ended = await revoke({ user: req.user, except: req.auth.sid, by: req.user, reason: 'password changed' });
  await audit(req.user, 'password', 'admin', a.id, { otherSessionsEnded: ended.length });
  res.json({ ok: true, otherSessionsEnded: ended.length });
}));

module.exports = router;
