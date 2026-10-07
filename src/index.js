import http from 'node:http';
import { config } from './config.js';
import { log } from './log.js';
import { migrate, ensureAdmin, pool } from './db.js';
import { redis } from './redis.js';
import { loadState } from './state.js';
import { ari } from './ari.js';
import { applyConfig } from './asterisk/manager.js';
import { startTracker } from './tracker.js';
import { startStats, flushPeaks } from './stats.js';
import { startEndpointPoller } from './live.js';
import { createApp } from './app.js';
import { attachWs } from './ws.js';

await migrate();
await ensureAdmin();
await loadState();
await applyConfig({ reason: 'startup' });

startTracker();
startStats();
startEndpointPoller();

// Every time Asterisk (re)connects, make sure it runs the current config
ari.on('connected', () => applyConfig({ reason: 'asterisk connected', forceReload: true }));
ari.connect();

const server = http.createServer(createApp());
attachWs(server);
server.listen(config.port, config.host, () => log.info(`SIP Distributor UI on http://${config.host}:${config.port}`));

async function shutdown(sig) {
  log.info(`${sig} received, shutting down`);
  server.close();
  try { await flushPeaks(); } catch { /* ignore */ }
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('Unhandled rejection:', e));
