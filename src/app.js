import express from 'express';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { q } from './db.js';
import { signToken, requireAuth, loginThrottle } from './auth.js';
import trunks from './routes/trunks.js';
import processes from './routes/processes.js';
import reports from './routes/reports.js';
import system from './routes/system.js';
import { log } from './log.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '100kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', loginThrottle, async (req, res) => {
    const { username, password } = req.body || {};
    const admin = (await q('SELECT * FROM admins WHERE username = $1', [String(username || '')])).rows[0];
    if (!admin || !(await bcrypt.compare(String(password || ''), admin.password_hash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    await q('UPDATE admins SET last_login = now() WHERE id = $1', [admin.id]);
    res.json({ token: signToken(admin), username: admin.username });
  });

  app.use('/api', requireAuth);
  app.get('/api/me', (req, res) => res.json({ username: req.admin.u }));
  app.use('/api/trunks', trunks);
  app.use('/api/processes', processes);
  app.use('/api/reports', reports);
  app.use('/api', system);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { maxAge: '1h' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: `Already exists: ${err.detail || err.message}` });
    if (err.code === '23503') return res.status(409).json({ error: 'Record is referenced by other data' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    log.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
