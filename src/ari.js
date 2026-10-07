'use strict';
// Minimal ARI client: REST calls + a self-reconnecting events WebSocket.
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const cfg = require('./config');

const auth = 'Basic ' + Buffer.from(`${cfg.ari.user}:${cfg.ari.pass}`).toString('base64');

async function call(method, path, body) {
  const res = await fetch(`${cfg.ari.url}/ari${path}`, {
    method,
    headers: { Authorization: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`ARI ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

const ari = {
  events: new EventEmitter(),
  connected: false,
  get: (p) => call('GET', p),
  put: (p, b) => call('PUT', p, b),
  post: (p, b) => call('POST', p, b),
  del: (p) => call('DELETE', p),

  info: () => call('GET', '/asterisk/info'),
  channels: () => call('GET', '/channels'),
  endpoints: () => call('GET', '/endpoints/PJSIP'),
  // PUT /asterisk/modules/{name} == "module reload <name>"
  reloadModule: (name) => call('PUT', `/asterisk/modules/${encodeURIComponent(name)}`),

  connect() {
    const url = cfg.ari.url.replace(/^http/, 'ws') +
      `/ari/events?app=${encodeURIComponent(cfg.ari.app)}&subscribeAll=true`;
    let retry = 1000;
    const open = () => {
      const ws = new WebSocket(url, { headers: { Authorization: auth } });
      ws.on('open', () => {
        retry = 1000; ari.connected = true;
        console.log('[ari] events connected');
        ari.events.emit('connected');
      });
      ws.on('message', (buf) => {
        let ev; try { ev = JSON.parse(buf); } catch { return; }
        ari.events.emit(ev.type, ev);
      });
      ws.on('close', () => {
        if (ari.connected) console.warn('[ari] events disconnected');
        ari.connected = false;
        ari.events.emit('disconnected');
        setTimeout(open, retry); retry = Math.min(retry * 2, 15000);
      });
      ws.on('error', (e) => { if (retry <= 1000) console.warn('[ari]', e.message); });
    };
    open();
  },
};

module.exports = ari;
