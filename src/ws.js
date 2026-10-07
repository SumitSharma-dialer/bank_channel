import { WebSocketServer } from 'ws';
import { verifyToken } from './auth.js';
import { snapshot } from './live.js';
import { log } from './log.js';

/** Pushes the live snapshot to every logged-in UI once per second */
export function attachWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    if (!verifyToken(token)) { ws.close(4401, 'Unauthorized'); return; }
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    try { ws.send(JSON.stringify({ type: 'live', data: await snapshot() })); } catch { /* ignore */ }
  });

  let busy = false;
  setInterval(async () => {
    if (busy || wss.clients.size === 0) return;
    busy = true;
    try {
      const msg = JSON.stringify({ type: 'live', data: await snapshot() });
      for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
    } catch (e) { log.warn('live push failed:', e.message); }
    busy = false;
  }, 1000);

  setInterval(() => {
    for (const c of wss.clients) {
      if (!c.isAlive) { c.terminate(); continue; }
      c.isAlive = false;
      c.ping();
    }
  }, 30000);
}
