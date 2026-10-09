/* SIP Channel Distributor — admin UI (no build step, plain JS) */
'use strict';

// ------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => (+n || 0).toLocaleString('en-IN');
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const fmtDur = (s) => { s = +s || 0; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}h ${m}m` : m ? `${m}m ${String(x).padStart(2, '0')}s` : `${x}s`; };
const fmtTime = (d) => d ? new Date(d).toLocaleString('en-GB', { timeZone: S.tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
const fmtShort = (d) => d ? new Date(d).toLocaleString('en-GB', { timeZone: S.tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(',', '') : '';
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: S.tz });
const dayStr = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: S.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const daysAgo = (n) => dayStr(new Date(Date.now() - n * 86400e3));

// monitor-only users (role viewer, e.g. team leaders) see only their tabs and processes; the server enforces the same
const isViewer = () => S.me && S.me.role === 'viewer';
const isSuper = () => S.me && S.me.role === 'superadmin';
// Activity log: super admins only
const canSee = (page) => (page === 'activity' ? isSuper() : !isViewer() || (S.me.tabs || []).includes(page));
const S = { me: null, tz: 'Asia/Kolkata', snap: null, trunks: [], processes: [], dispositions: [], feed: [], ws: null, page: null };

// requests started inside bg() are timer refreshes: marked X-Poll so they stay out of the activity log
let inBg = false;
const bg = (fn) => { inBg = true; try { return fn(); } finally { inBg = false; } };
async function api(method, url, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (inBg) headers['X-Poll'] = '1';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('login required'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
  return data;
}

function toast(msg, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), bad ? 6000 : 3200);
}
function applyToast(r, what) {
  const a = r && r.apply;
  if (a && a.ok === false) toast(`${what} saved, but Asterisk reload failed: ${a.error}`, true);
  else toast(`${what} saved — Asterisk updated`);
}

const DISP_CLASS = { ANSWERED: 'ok', BUSY: 'warn', NO_ANSWER: 'warn', CANCEL: '', CONGESTION: 'bad', FAILED: 'bad',
  CHANNEL_LIMIT: 'info', TRUNK_LIMIT: 'info', BLOCKED: 'bad', NO_ROUTE: 'bad', INVALID: 'bad', OFF_HOURS: 'warn', NO_HEADER: 'bad', INVALID_DID: 'bad', SIP_DOWN: 'bad' };
// custom code set on the Dispositions page (e.g. CHANNEL_LIMIT -> LIMIT_REACH), else the internal code
const dispInfo = (d) => S.dispositions.find((x) => x.code === d) || {};
const dispName = (d) => dispInfo(d).custom_code || d;
const dispChip = (d) => `<span class="chip ${DISP_CLASS[d] || ''}" title="${esc(d)} — ${esc(dispInfo(d).label || '')}">${esc(dispName(d))}</span>`;
function meter(live, max) {
  const p = max ? Math.min(100, (live / max) * 100) : 0;
  const cls = p >= 95 ? 'bad' : p >= 80 ? 'warn' : '';
  return `<div class="meter ${cls}"><span style="width:${p}%"></span></div>`;
}
function usage(live, max) {
  return `<div class="usage">${meter(live, max)}<span class="num">${fmtInt(live)} / ${max ? fmtInt(max) : '∞'}</span></div>`;
}

// ------------------------------------------------------------------ modal
function openModal(title, html, onMount) {
  const m = $('#modal'), card = $('.modal-card', m);
  card.innerHTML = `<header><h3>${esc(title)}</h3><button class="x" data-close aria-label="Close">×</button></header>${html}`;
  m.classList.remove('hidden');
  $$('[data-close]', card).forEach((b) => b.addEventListener('click', closeModal));
  if (onMount) onMount(card);
  const f = $('input:not([type=hidden]):not([readonly]), select', card); if (f) f.focus();
}
function closeModal() { $('#modal').classList.add('hidden'); $('.modal-card').innerHTML = ''; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
const confirmBox = (title, text, okLabel = 'Delete') => new Promise((resolve) => {
  openModal(title, `<div class="mbody"><p>${text}</p><div class="mfoot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="okBtn">${esc(okLabel)}</button></div></div>`,
    (c) => $('#okBtn', c).addEventListener('click', () => { closeModal(); resolve(true); }));
  $$('#modal [data-close]').forEach((b) => b.addEventListener('click', () => resolve(false)));
});
const formData = (form) => Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

// ------------------------------------------------------------------ auth
function showLogin() { S.feed = []; S.snap = null; S.me = null; $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; } }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#loginErr').textContent = '';
  try { await api('POST', '/api/login', formData(e.target)); boot(); }
  catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('POST', '/api/logout'); showLogin(); });
$('#myPw').addEventListener('click', () => openModal('Change your password', `<form class="mbody" id="mpf" style="display:flex;flex-direction:column;gap:10px">
    <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
    <label>New password <small>at least 8 characters</small><input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
    <p class="hint">Your other sessions (other browsers / devices) are signed out.</p>
    <p class="err" id="mpErr"></p><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Change password</button></div></form>`, (c) => {
  $('#mpf', c).onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await api('POST', '/api/me/password', formData(e.target)); closeModal(); toast(`Password changed${r.otherSessionsEnded ? ` · ${r.otherSessionsEnded} other session(s) signed out` : ''}`); }
    catch (er) { $('#mpErr', c).textContent = er.message; }
  };
}));

async function boot() {
  try { S.me = await api('GET', '/api/me'); } catch { return showLogin(); }
  S.tz = S.me.tz || S.tz;
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#who').textContent = S.me.user + (isViewer() ? ' · monitor' : isSuper() ? ' · super admin' : '');
  $$('#nav a').forEach((a) => a.classList.toggle('hidden', !canSee(a.dataset.page)));
  S.dispositions = await api('GET', '/api/reports/dispositions').catch(() => []);
  connectWs(); route();
}

// ------------------------------------------------------------------ websocket
function connectWs() {
  if (S.ws) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  ws.onmessage = (m) => {
    const { type, data } = JSON.parse(m.data);
    if (type === 'snapshot') { S.snap = data; setConn(data.ariConnected); issueBadge(data.issues); if (S.page === 'live') Live.update(); }
    if (type === 'hit' && S.page === 'live') Live.hit(data);
    if (type === 'call') { S.feed.unshift(data); S.feed.length = Math.min(S.feed.length, 60); if (S.page === 'live') Live.feed(data); }
  };
  ws.onclose = (ev) => { S.ws = null; setConn(null);
    if (ev.code === 4401) { toast(ev.reason === 'signed in elsewhere' ? 'Your account was signed in on another browser or device — this session was signed out' : 'Your session was ended — sign in again', true); showLogin(); return; } setTimeout(() => { if (!$('#app').classList.contains('hidden')) connectWs(); }, 2000); };
}
function issueBadge(i) {
  const b = $('#navIssues'); if (!i) return;
  const n = i.critical + i.warning;
  b.classList.toggle('hidden', !n); b.classList.toggle('warn', !i.critical);
  b.textContent = n; b.title = `${i.critical} critical, ${i.warning} warning open issues`;
}
function setConn(ari) {
  const c = $('#conn');
  c.className = 'conn ' + (ari === true ? 'ok' : ari === false ? 'bad' : '');
  c.lastElementChild.textContent = ari === true ? 'Asterisk ARI connected' : ari === false ? 'ARI disconnected' : 'live feed offline';
}

// ------------------------------------------------------------------ router
const PAGES = {};
function route() {
  const page = (location.hash.replace(/^#\//, '') || 'live').split('?')[0];
  const first = ['live', 'cdr', 'stats'].find(canSee) || 'live';
  const p = PAGES[page] && canSee(page) ? page : first;
  S.page = p;
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.page === p));
  closeModal();
  PAGES[p]($('#main'));
}
window.addEventListener('hashchange', route);

// =================================================================== LIVE
const Live = {
  key: '',
  render(main) {
    Live.key = '';
    main.innerHTML = `
      <div class="head"><div><h1>Live dashboard</h1><p>Real-time channel usage from Redis · updates every second</p></div>
        <div class="actions"><span class="chip" id="lvClock">—</span></div></div>
      <div class="grid kpis">
        <div class="panel kpi"><div class="lab">Live channels</div><div class="val num" id="kLive">0</div><div class="meter" id="kLiveM"><span></span></div><div class="sub" id="kLiveS"></div></div>
        <div class="panel kpi"><div class="lab">Hits / minute</div><div class="val num" id="kHits">0</div><div class="sub" id="kHitsS"></div></div>
        <div class="panel kpi"><div class="lab">Peak today</div><div class="val num" id="kPeak">0</div><div class="sub">concurrent channels</div></div>
        <div class="panel kpi${isViewer() ? ' hidden' : ''}"><div class="lab">Trunks up</div><div class="val num" id="kTr">0</div><div class="sub" id="kTrS"></div></div>
      </div>
      <div class="grid live-top">
        <div class="panel"><h2>Call flow <span id="gNote" style="text-transform:none;letter-spacing:0;font-weight:500"></span></h2>
          <div class="graph" id="graph"></div>
          <div class="legend"><span>● node flashes on every new call</span><span>edge width = channels in use</span><span>dashed = inactive</span></div></div>
        <div class="panel"><h2>Finished calls <span class="chip" id="feedN">0</span></h2><ul class="feed" id="feed"></ul></div>
      </div>
      <div class="grid two">
        <div class="panel"><h2>Processes</h2><div class="tw"><table><thead><tr><th>Process</th><th>Usage</th><th class="r">Hits/min</th><th class="r">Today</th><th class="r">Peak</th></tr></thead><tbody id="lvP"></tbody></table></div></div>
        <div class="panel${isViewer() ? ' hidden' : ''}"><h2>SIP trunks</h2><div class="tw"><table><thead><tr><th>Trunk</th><th>Usage</th><th>Status</th><th class="r">Peak</th></tr></thead><tbody id="lvT"></tbody></table></div></div>
      </div>`;
    Live.feed();
    if (S.snap) Live.update(); else api('GET', '/api/live').then((s) => { S.snap = s; Live.update(); }).catch(() => {});
  },
  update() {
    const s = S.snap; if (!s || !$('#kLive')) return;
    const cap = s.trunkCapacity || s.processCapacity;
    $('#lvClock').textContent = clock(s.at);
    $('#kLive').innerHTML = `${fmtInt(s.live)}<small> / ${fmtInt(cap)}</small>`;
    const p = pct(s.live, cap);
    $('#kLiveM').className = 'meter ' + (p >= 95 ? 'bad' : p >= 80 ? 'warn' : ''); $('#kLiveM span').style.width = Math.min(100, p) + '%';
    $('#kLiveS').textContent = s.viewer ? `${p}% of your processes' channel limit` : `${p}% of trunk capacity · ${fmtInt(s.processCapacity)} sold to processes`;
    $('#kHits').textContent = fmtInt(s.hitsMin);
    $('#kHitsS').textContent = `${fmtInt(s.hitsToday)} calls received today`;
    $('#kPeak').textContent = fmtInt(s.peakToday);
    if (s.viewer) $('#kPeak').nextElementSibling.textContent = 'sum of your process peaks';
    const up = s.trunks.filter((t) => t.active && t.state === 'online').length;
    $('#kTr').innerHTML = `${up}<small> / ${s.trunks.filter((t) => t.active).length}</small>`;
    $('#kTrS').textContent = s.ariConnected ? 'qualify status from Asterisk' : 'Asterisk not connected';

    $('#lvP').innerHTML = s.processes.length ? s.processes.map((x) => `<tr>
      <td class="t-name"><b>${esc(x.name)}</b><small>${esc(x.code)}${s.viewer ? '' : ` → ${esc(x.trunk || 'no trunk')}`}${x.active ? '' : ' · inactive'}</small></td>
      <td>${usage(x.live, x.limit)}</td><td class="r num">${fmtInt(x.hitsMin)}</td><td class="r num">${fmtInt(x.hitsToday)}</td><td class="r num">${fmtInt(x.peak)}</td></tr>`).join('')
      : `<tr><td colspan="5" class="empty">${s.viewer ? 'No processes assigned to your user — ask an admin.' : 'No processes yet — <a href="#/processes">add one</a>'}</td></tr>`;
    $('#lvT').innerHTML = s.trunks.length ? s.trunks.map((t) => `<tr>
      <td class="t-name"><b>${esc(t.name)}</b><small>${fmtInt(t.assigned)} ch assigned</small></td>
      <td>${usage(t.live, t.max)}</td><td>${trunkStatus(t)}</td><td class="r num">${fmtInt(t.peak)}</td></tr>`).join('')
      : `<tr><td colspan="4" class="empty">No trunks yet — <a href="#/trunks">add one</a></td></tr>`;
    Live.graph();
  },
  graph() {
    const s = S.snap, box = $('#graph'); if (!box) return;
    const MAXN = 10;
    const procs = s.processes.slice().sort((a, b) => b.live - a.live || a.code.localeCompare(b.code)).slice(0, MAXN);
    const trunks = s.trunks.slice(0, MAXN);
    $('#gNote').textContent = s.processes.length > MAXN ? `top ${MAXN} of ${s.processes.length} processes` : '';
    const key = procs.map((p) => p.code + p.active).join() + '|' + trunks.map((t) => t.name + t.active).join();
    const W = 900, H = 360, nh = 40, nw = 176;
    const ys = (n) => Array.from({ length: n }, (_, i) => (n === 1 ? H / 2 : 30 + (i * (H - 60)) / (n - 1)));
    const py = ys(procs.length), ty = ys(trunks.length);
    const hub = { x: W / 2 - 75, y: H / 2 - 32, w: 150, h: 64 };
    const curve = (x1, y1, x2, y2) => { const mx = (x1 + x2) / 2; return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`; };
    if (key !== Live.key) {
      Live.key = key;
      let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
      procs.forEach((p, i) => { svg += `<path id="e-p-${p.code}" class="g-edge" d="${curve(20 + nw, py[i], hub.x, H / 2)}"/>`; });
      trunks.forEach((t, i) => { svg += `<path id="e-t-${t.name}" class="g-edge" d="${curve(hub.x + hub.w, H / 2, W - 20 - nw, ty[i])}"/>`; });
      procs.forEach((p, i) => { svg += `<g class="g-node${p.active ? '' : ' off'}" id="n-p-${p.code}" transform="translate(20,${py[i] - nh / 2})"><rect width="${nw}" height="${nh}" rx="8"/><text x="12" y="17">${esc(p.code)}</text><text class="sub" x="12" y="32" data-v></text></g>`; });
      svg += `<g class="g-node g-hub" transform="translate(${hub.x},${hub.y})"><rect width="${hub.w}" height="${hub.h}" rx="10"/><text x="${hub.w / 2}" y="27" text-anchor="middle">SIPDist</text><text class="sub" x="${hub.w / 2}" y="46" text-anchor="middle" id="hubV"></text></g>`;
      trunks.forEach((t, i) => { svg += `<g class="g-node${t.active ? '' : ' off'}" id="n-t-${t.name}" transform="translate(${W - 20 - nw},${ty[i] - nh / 2})"><rect width="${nw}" height="${nh}" rx="8"/><text x="12" y="17">${esc(t.name)}</text><text class="sub" x="12" y="32" data-v></text></g>`; });
      if (!procs.length && !trunks.length && !s.viewer) svg += `<text x="${W / 2}" y="${H / 2 + 60}" text-anchor="middle" fill="currentColor" opacity=".5">Add a trunk and a process to see the flow</text>`;
      box.innerHTML = svg + '</svg>';
    }
    const width = (live, max) => 1.5 + Math.min(9, max ? (live / max) * 9 : live ? 4 : 0);
    procs.forEach((p) => {
      const e = $(`#e-p-${p.code}`), n = $(`#n-p-${p.code} [data-v]`);
      if (e) { e.style.strokeWidth = width(p.live, p.limit); e.classList.toggle('busy', p.live > 0); }
      if (n) n.textContent = `${p.live}/${p.limit} ch · ${p.hitsMin}/min`;
    });
    trunks.forEach((t) => {
      const e = $(`#e-t-${t.name}`), n = $(`#n-t-${t.name} [data-v]`);
      if (e) { e.style.strokeWidth = width(t.live, t.max); e.classList.toggle('busy', t.live > 0); }
      if (n) n.textContent = `${t.live}/${t.max || '∞'} ch · ${t.state}`;
    });
    const hv = $('#hubV'); if (hv) hv.textContent = `${s.live} live`;
  },
  hit(h) {
    const node = $(`#n-p-${CSS.escape(h.process)}`);
    if (node) { node.classList.remove('flash'); void node.getBBox(); node.classList.add('flash'); }
    const path = $(`#e-p-${CSS.escape(h.process)}`);
    if (path && path.ownerSVGElement) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('r', '4.5'); c.setAttribute('class', 'pulse');
      const len = path.getTotalLength(); const t0 = performance.now();
      path.ownerSVGElement.append(c);
      const step = (t) => { const k = Math.min(1, (t - t0) / 700); const pt = path.getPointAtLength(k * len); c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y); if (k < 1) requestAnimationFrame(step); else c.remove(); };
      requestAnimationFrame(step);
    }
  },
  feedItem(c, anim) {
    return `<li${anim ? '' : ' style="animation:none"'}><span class="t">${clock(c.at)}</span>
      <span class="n">${esc(c.number || '—')} <small>${esc(c.process || '')}${c.bill ? ' · ' + fmtDur(c.bill) : ''}</small></span>${dispChip(c.disposition)}</li>`;
  },
  feed(added) {
    const ul = $('#feed'); if (!ul) return;
    $('#feedN').textContent = S.feed.length;
    if (added && S.feed.length > 1) {
      ul.insertAdjacentHTML('afterbegin', Live.feedItem(added, true));
      while (ul.children.length > 60) ul.lastElementChild.remove();
      return;
    }
    ul.innerHTML = S.feed.length ? S.feed.map((c) => Live.feedItem(c, !!added)).join('')
      : `<li style="grid-template-columns:1fr;animation:none"><span class="t" style="font-family:var(--sans)">Calls appear here as they finish.</span></li>`;
  },
};
function trunkStatus(t) {
  if (!t.active) return '<span class="chip">inactive</span>';
  const st = t.state === 'online' ? 'ok' : t.state === 'offline' ? 'bad' : '';
  const rg = /^Registered$/i.test(t.reg) ? 'ok' : t.reg === 'n/a' || t.reg === 'unknown' ? '' : 'warn';
  return `<span class="chip ${st}">${esc(t.state)}</span> ${t.reg !== 'n/a' ? `<span class="chip ${rg}">${esc(t.reg)}</span>` : ''}`;
}
PAGES.live = Live.render;

// =================================================================== TRUNKS
const didLabel = (r) => (r.first_did === r.last_did ? r.first_did : `${r.first_did}–${r.last_did}`);
const didCount = (r) => Number(r.last_did) - Number(r.first_did) + 1;
// trunks whose DID list is expanded (collapsed by default), remembered per browser
const didOpen = new Set((() => { try { return JSON.parse(localStorage.getItem('sd.didOpen') || '[]'); } catch { return []; } })());
const saveDidOpen = () => { try { localStorage.setItem('sd.didOpen', JSON.stringify([...didOpen])); } catch {} };

PAGES.trunks = async (main) => {
  main.innerHTML = `<div class="head"><div><h1>SIP trunks</h1></div>
    <div class="actions"><input id="tSearch" type="search" placeholder="Search trunk, host or DID…" style="width:240px"><button class="btn primary" id="addTrunk">+ Add trunk</button></div></div>
    <div class="grid kpis" id="tKpis"></div>
    <div id="tCards" class="tcards"><div class="panel empty">Loading…</div></div>`;
  $('#addTrunk').onclick = () => trunkForm();
  $('#tSearch').oninput = drawTrunks;
  await loadTrunks();
};
async function loadTrunks() {
  S.trunks = await api('GET', '/api/trunks');
  drawTrunks();
}
function drawTrunks() {
  const box = $('#tCards'); if (!box) return;
  const live = Object.fromEntries((S.snap?.trunks || []).map((t) => [t.name, t]));
  const all = S.trunks;

  // summary tiles
  const ranges = all.flatMap((t) => t.did_ranges || []);
  const dids = ranges.reduce((s, r) => s + didCount(r), 0);
  const assigned = ranges.filter((r) => r.process_id).reduce((s, r) => s + didCount(r), 0);
  const act = all.filter((t) => t.active);
  const online = act.filter((t) => (live[t.name] || {}).state === 'online').length;
  const cap = act.reduce((s, t) => s + (+t.max_channels || 0), 0);
  const liveNow = act.reduce((s, t) => s + ((live[t.name] || {}).live || 0), 0);
  $('#tKpis').innerHTML = `
    <div class="panel kpi"><div class="lab">Trunks</div><div class="val num">${act.length}<small> / ${all.length}</small></div><div class="sub">${online} online · ${all.length - act.length} inactive</div></div>
    <div class="panel kpi"><div class="lab">Channels</div><div class="val num">${fmtInt(liveNow)}<small> / ${cap ? fmtInt(cap) : '∞'}</small></div>${meter(liveNow, cap)}</div>
    <div class="panel kpi"><div class="lab">DID numbers</div><div class="val num">${fmtInt(dids)}</div><div class="sub">${ranges.length} range${ranges.length === 1 ? '' : 's'} on ${all.filter((t) => (t.did_ranges || []).length).length} trunk(s)</div></div>
    <div class="panel kpi"><div class="lab">DIDs free</div><div class="val num">${fmtInt(dids - assigned)}</div><div class="sub">${fmtInt(assigned)} assigned to processes</div></div>`;

  // filter
  const qv = ($('#tSearch')?.value || '').trim().toLowerCase();
  const list = !qv ? all : all.filter((t) => [t.name, t.description, t.host].some((x) => String(x || '').toLowerCase().includes(qv)) ||
    (t.did_ranges || []).some((r) => /^\d+$/.test(qv) ? (qv.length <= r.first_did.length && (r.first_did.includes(qv) || r.last_did.includes(qv) ||
      (qv.length === r.first_did.length && BigInt(qv) >= BigInt(r.first_did) && BigInt(qv) <= BigInt(r.last_did)))) : String(r.note || '').toLowerCase().includes(qv)));
  if (!all.length) { box.innerHTML = `<div class="panel empty">No trunks yet. Add your carrier trunk first, then add its DID numbers and create processes on it.</div>`; return; }
  if (!list.length) { box.innerHTML = `<div class="panel empty">No trunk matches “${esc(qv)}”.</div>`; return; }

  box.innerHTML = list.map((t) => {
    const L = live[t.name] || { live: 0, state: 'unknown', reg: t.register ? 'unknown' : 'n/a' };
    const over = t.max_channels && t.assigned_channels > t.max_channels;
    const rs = t.did_ranges || [];
    const n = rs.reduce((s, r) => s + didCount(r), 0), nA = rs.filter((r) => r.process_id).reduce((s, r) => s + didCount(r), 0);
    const nCli = rs.filter((r) => r.use_as_cli).reduce((s, r) => s + didCount(r), 0);
    return `<section class="panel tcard${t.active ? '' : ' off'}">
      <header class="tc-head">
        <div class="tc-title"><b>${esc(t.name)}</b>${trunkStatus({ ...L, active: t.active })}<small>${esc(t.description || '')}</small></div>
        <div class="ops"><button class="btn sm" data-edit="${t.id}">Edit</button>
          <button class="btn sm" data-toggle="${t.id}">${t.active ? 'Deactivate' : 'Activate'}</button>
          <button class="btn sm danger" data-del="${t.id}">Delete</button></div>
      </header>
      <div class="tc-facts">
        <div><span>Host</span><b class="mono">${esc(t.host)}:${t.port}</b><small>${t.transport.toUpperCase()}${t.register ? ' · registers' : ''}${t.cps ? ` · max ${t.cps} CPS` : ''}${t.prefix ? ` · number prefix ${esc(t.prefix)}` : ''}${t.cli_prefix ? ` · DID prefix ${esc(t.cli_prefix)}` : ''}</small></div>
        <div><span>Live channels</span>${usage(L.live, t.max_channels)}</div>
        <div><span>Sold to processes</span><b class="num">${fmtInt(t.assigned_channels)} ch</b><small>${t.process_count} process${t.process_count === 1 ? '' : 'es'}${over ? ' · <span class="chip warn">oversubscribed</span>' : ''}</small></div>
        <div><span>Inbound calls</span>${t.allow_inbound === false ? '<b><span class="chip bad">blocked</span></b><small>all carrier calls rejected</small>'
          : `<b><span class="chip ok">allowed</span></b><small>${rs.length ? 'to its DIDs · callback to the process that used the DID' : 'no DIDs yet — rejected'}</small>`}</div>
      </div>
      <div class="tc-dids${didOpen.has(t.id) ? ' open' : ''}">
        <div class="tc-dids-head"><button type="button" class="tc-toggle" data-did="${t.id}" ${rs.length ? '' : 'disabled'} aria-expanded="${didOpen.has(t.id)}"><i>▸</i><b>DID numbers</b> ${n ? `<span class="num">${fmtInt(n)}</span> in ${rs.length} range${rs.length === 1 ? '' : 's'} · <span class="num">${fmtInt(nA)}</span> assigned · <span class="num">${fmtInt(n - nA)}</span> free · <span class="num">${fmtInt(nCli)}</span> used as caller ID` : '<span>none</span>'}</button>
          <button class="btn sm" data-adddid="${t.id}">+ Add DID range</button></div>
        ${rs.length ? `<div class="tw tc-body"><table class="did-table"><thead><tr><th>DID range</th><th class="r">Numbers</th><th title="1. process that last called the caller from this DID  2. process that last used the DID  3. assigned process">Inbound calls go to</th><th>Caller ID</th><th>Note</th></tr></thead><tbody>
          ${rs.map((r) => `<tr><td class="mono">${esc(didLabel(r))}</td><td class="r num">${fmtInt(didCount(r))}</td>
            <td>${t.allow_inbound === false ? `<span class="chip bad" title="inbound blocked on this trunk">blocked</span>${r.process_code ? ` <small style="color:var(--ink-3)">${esc(r.process_code)}</small>` : ''}`
              : r.process_code ? `<span class="chip ok">${esc(r.process_code)}</span> <small style="color:var(--ink-3)">if no callback match</small>` : '<span class="chip">last caller-ID user</span>'}</td>
            <td>${r.use_as_cli ? '<span class="chip info">yes</span>' : '<span style="color:var(--ink-3)">no</span>'}</td>
            <td style="color:var(--ink-2)">${esc(r.note || '')}</td></tr>`).join('')}</tbody></table></div>`
        : ''}
      </div></section>`;
  }).join('');

  const find = (b, k) => S.trunks.find((x) => x.id === +b.dataset[k]);
  $$('[data-edit]', box).forEach((b) => (b.onclick = () => trunkForm(find(b, 'edit'))));
  $$('[data-did]', box).forEach((b) => (b.onclick = () => {
    const id = +b.dataset.did, open = !didOpen.has(id);
    open ? didOpen.add(id) : didOpen.delete(id); saveDidOpen();
    b.closest('.tc-dids').classList.toggle('open', open); b.setAttribute('aria-expanded', open);
  }));
  $$('[data-adddid]', box).forEach((b) => (b.onclick = () => trunkForm(find(b, 'adddid'), { addDid: true })));
  $$('[data-toggle]', box).forEach((b) => (b.onclick = async () => {
    const t = find(b, 'toggle');
    if (t.active && t.process_count && !(await confirmBox('Deactivate trunk', `Processes on <b>${esc(t.name)}</b> will get 503 (NO_ROUTE) until it is active again. Live calls are not cut.`, 'Deactivate'))) return;
    try { applyToast(await api('POST', `/api/trunks/${t.id}/active`, { active: !t.active }), 'Trunk'); loadTrunks(); } catch (e) { toast(e.message, true); }
  }));
  $$('[data-del]', box).forEach((b) => (b.onclick = async () => {
    const t = find(b, 'del');
    const nd = (t.did_ranges || []).length;
    if (!(await confirmBox('Delete trunk', `Delete <b>${esc(t.name)}</b>? ${t.process_count} process(es) will be left without a trunk${nd ? ` and its ${nd} DID range(s) are removed` : ''}.`))) return;
    try { applyToast(await api('DELETE', `/api/trunks/${t.id}`), 'Trunk'); loadTrunks(); } catch (e) { toast(e.message, true); }
  }));
}
async function trunkForm(t, opt = {}) {
  const procs = await api('GET', '/api/processes');
  const v = t || { allow_inbound: true, port: 5060, transport: 'udp', register: true, max_channels: 30, cps: 0, strip_digits: 0, prefix: '', cli_prefix: '', codecs: 'ulaw,alaw', dial_timeout: 60, active: true };
  openModal(t ? `Edit trunk ${t.name}` : 'Add SIP trunk', `<form id="tf"><div class="fgrid">
    <label>Trunk name <small>a-z 0-9 _ (used in Asterisk as t_name)</small><input name="name" value="${esc(v.name || '')}" required pattern="[a-z0-9_]{2,32}" ${t ? '' : 'autofocus'}></label>
    <label>Description<input name="description" value="${esc(v.description || '')}" placeholder="Carrier / circle"></label>
    <div class="fsec">Connection</div>
    <label>Host / IP<input name="host" value="${esc(v.host || '')}" required placeholder="sip.carrier.com"></label>
    <div class="row"><label>Port<input name="port" type="number" value="${v.port}" min="1" max="65535"></label>
      <label>Transport<select name="transport"><option ${v.transport === 'udp' ? 'selected' : ''}>udp</option><option ${v.transport === 'tcp' ? 'selected' : ''}>tcp</option></select></label></div>
    <label>SIP username<input name="username" value="${esc(v.username || '')}" autocomplete="off"></label>
    <label>SIP password <small>${t && t.has_password ? 'leave blank to keep current' : ''}</small><input name="password" type="password" autocomplete="new-password"></label>
    <label class="check"><input type="checkbox" name="register" ${v.register ? 'checked' : ''}> Register to carrier (needs username + password)</label>
    <div class="row"><label>From user <small>optional</small><input name="from_user" value="${esc(v.from_user || '')}"></label>
      <label>From domain <small>optional</small><input name="from_domain" value="${esc(v.from_domain || '')}"></label></div>
    <div class="fsec">Number format (outbound)</div>
    <div class="row"><label>Customer number prefix <small>before the last 10 digits, e.g. 0 or +91</small><input name="prefix" class="mono" value="${esc(v.prefix || '')}" pattern="\\+?[0-9]{0,20}" placeholder="none"></label>
      <label>DID prefix <small>caller ID, before the last 10 digits</small><input name="cli_prefix" class="mono" value="${esc(v.cli_prefix || '')}" pattern="\\+?[0-9]{0,20}" placeholder="none"></label></div>
    <p class="hint full" id="pfxPrev"></p>
    <div class="fsec">Capacity</div>
    <div class="row"><label>Total channels <small>hard limit on this trunk, 0 = unlimited</small><input name="max_channels" type="number" min="0" value="${v.max_channels}" required></label>
      <label>CPS <small>new calls per second, 0 = unlimited</small><input name="cps" type="number" min="0" max="1000" value="${v.cps || 0}" required></label></div>
    <p class="hint full">Calls over the CPS limit wait (up to 3 s) for a free slot, then are rejected as TRUNK_LIMIT.</p>
    <div class="fsec">DID numbers on this trunk</div>
    <p class="hint full">Ranges of numbers the carrier gave you. <b>Caller ID</b> = processes in “random DID from trunk” mode send one of these numbers.
      <b>Inbound to</b> = calls from the carrier to these numbers are sent to that process. A single DID: leave “last” blank.</p>
    <label class="check full"><input type="checkbox" name="allow_inbound" ${v.allow_inbound !== false ? 'checked' : ''}> Allow inbound calls from this trunk
      <small>— off = every call from the carrier is rejected; DIDs can still be used as caller ID</small></label>
    <div class="full did-list" id="didList"></div>
    <div class="full"><button type="button" class="btn sm" id="addDid">+ Add DID range</button></div>
    <label class="check full"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active</label>
  </div><p class="err" id="tErr"></p><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${t ? 'Save & apply' : 'Add trunk'}</button></div></form>`,
  (c) => {
    const f = $('#tf', c);
    // DID range rows: inputs have no name= so formData() skips them; collected on submit
    const list = $('#didList', c);
    // only processes on this trunk can own its DIDs (a new trunk has none yet)
    const procOpts = (sel) => `<option value="">— reject inbound —</option>` + procs.filter((p) => t && p.trunk_id === t.id).map((p) =>
      `<option value="${p.id}" ${sel === p.id ? 'selected' : ''}>${esc(p.code)}</option>`).join('');
    const addRow = (r = { use_as_cli: true }) => {
      const el = document.createElement('div'); el.className = 'did-row';
      el.innerHTML = `<input class="mono d-first" value="${esc(r.first_did || '')}" placeholder="First DID" pattern="\\+?[0-9]{4,15}" required>
        <input class="mono d-last" value="${esc(r.last_did && r.last_did !== r.first_did ? r.last_did : '')}" placeholder="Last (optional)" pattern="\\+?[0-9]{4,15}">
        <select class="d-proc" title="Inbound calls to these DIDs go to">${procOpts(r.process_id)}</select>
        <label class="check" title="Use as outbound caller ID"><input type="checkbox" class="d-cli" ${r.use_as_cli ? 'checked' : ''}> Caller ID</label>
        <input class="d-note" value="${esc(r.note || '')}" placeholder="Note">
        <button type="button" class="btn sm danger" title="Remove">✕</button>`;
      $('button', el).onclick = () => { el.remove(); count(); };
      list.appendChild(el); count();
    };
    const count = () => { list.dataset.empty = list.children.length ? '' : 'No DID ranges — outbound caller ID comes from the process, inbound calls are rejected.'; };
    (v.did_ranges || []).forEach(addRow); count();
    // live preview of what the carrier receives (number and DID are cut to their last 10 digits first)
    const prev = () => { $('#pfxPrev', c).innerHTML = `Sent to carrier: number <b class="mono">${esc(f.elements.prefix.value)}9876543210</b>, caller ID <b class="mono">${esc(f.elements.cli_prefix.value)}8012345678</b>`; };
    f.elements.prefix.oninput = f.elements.cli_prefix.oninput = prev; prev();
    if (opt.addDid) { addRow(); const el = $('.did-row:last-child .d-first', list); el.scrollIntoView({ block: 'center' }); el.focus(); }
    $('#addDid', c).onclick = () => { addRow(); $('.did-row:last-child .d-first', list).focus(); };
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formData(f); d.register = f.register.checked; d.active = f.active.checked; d.allow_inbound = f.allow_inbound.checked;
      d.did_ranges = $$('.did-row', list).map((el) => ({ first_did: $('.d-first', el).value.trim(), last_did: $('.d-last', el).value.trim(),
        process_id: $('.d-proc', el).value || null, use_as_cli: $('.d-cli', el).checked, note: $('.d-note', el).value.trim() }));
      try { const r = await api(t ? 'PUT' : 'POST', t ? `/api/trunks/${t.id}` : '/api/trunks', d); closeModal(); applyToast(r, 'Trunk'); loadTrunks(); }
      catch (err) { $('#tErr').textContent = err.message; }
    });
  });
}

// =================================================================== PROCESSES
const WEEK = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
function daysText(days) {   // ['mon'..'fri'] -> "Mon–Fri", ['mon','wed'] -> "Mon, Wed"
  const idx = WEEK.map((w) => w[0]).filter((d) => days.includes(d)).map((d) => WEEK.findIndex((w) => w[0] === d));
  if (idx.length === 7) return 'every day';
  const runs = []; idx.forEach((i) => { const r = runs[runs.length - 1]; if (r && r[1] === i - 1) r[1] = i; else runs.push([i, i]); });
  return runs.map(([a, b]) => (a === b ? WEEK[a][1] : b === a + 1 ? `${WEEK[a][1]}, ${WEEK[b][1]}` : `${WEEK[a][1]}–${WEEK[b][1]}`)).join(', ');
}
// chip for one direction in the process list
function dirChip(label, allowed, h) {
  if (!allowed) return `<span class="chip bad">${label} off</span>`;
  return h ? `<span class="chip warn" title="${esc(daysText(h.days))} ${esc(h.from)}–${esc(h.to)} (${esc(S.tz)})">${label} ${esc(h.from)}–${esc(h.to)} · ${esc(daysText(h.days))}</span>`
    : `<span class="chip ok">${label} 24×7</span>`;
}
const HDR_TXT = { ok: 'OK', none: 'no headers', missing: 'header missing', bad_number: 'bad number', bad_did: 'DID not allowed' };
async function headerLog(p) {
  const rows = await api('GET', `/api/processes/${p.id}/header-log`);
  const chip = (st) => `<span class="chip ${st === 'ok' ? 'ok' : st === 'none' ? '' : 'bad'}">${esc(HDR_TXT[st] || st)}</span>`;
  openModal(`Header log · ${p.name}`, `<div class="mbody">
    <p class="hint" style="margin-bottom:12px">Last 50 calls to dummy number <b class="mono">${esc(p.dummy_cli)}</b> and the headers the client sent
      (<span class="mono">X-DID</span> = caller-ID DID, <span class="mono">X-Number</span> = customer number). “—” = header not sent.</p>
    <div class="tw"><table><thead><tr><th>Time</th><th>X-DID</th><th>X-Number</th><th>Header check</th><th>Disposition</th><th class="r">Talk</th></tr></thead><tbody>
    ${rows.length ? rows.map((r) => `<tr><td class="mono" style="font-size:12.5px;white-space:nowrap">${fmtTime(r.start_time)}</td>
      <td class="mono">${r.hdr_did ? esc(r.hdr_did) : '<span style="color:var(--ink-3)">—</span>'}</td><td class="mono">${r.hdr_num ? esc(r.hdr_num) : '<span style="color:var(--ink-3)">—</span>'}</td>
      <td>${chip(r.hdr_status)}</td><td>${dispChip(r.disposition)}</td><td class="r num">${fmtDur(r.bill_sec)}</td></tr>`).join('')
      : `<tr><td colspan="6" class="empty">No outbound calls yet. Ask the client to place a test call.</td></tr>`}
    </tbody></table></div>
    <div class="mfoot"><button class="btn" id="hlRefresh">Refresh</button><button class="btn primary" data-close>Close</button></div></div>`,
  (c) => { $('#hlRefresh', c).onclick = () => headerLog(p); });
}
// allow + working time block in the process form; dir = 'out' | 'in'
function dirBlock(dir, title, desc, allowed, h) {
  const on = !!h, x = h || { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], from: '09:00', to: '18:00' };
  return `<div class="dirbox full" data-dir="${dir}">
    <label class="check"><input type="checkbox" class="d-allow" ${allowed ? 'checked' : ''}> <b>${title}</b> <small>${desc}</small></label>
    <div class="d-sub">
      <label class="check"><input type="checkbox" class="d-timed" ${on ? 'checked' : ''}> Only during working time <small>(${esc(S.tz)})</small></label>
      <div class="d-hours">
        <div class="daypick">${WEEK.map(([d, l]) => `<label><input type="checkbox" value="${d}" ${x.days.includes(d) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
        <div class="row"><label>From<input type="time" class="d-from" value="${esc(x.from)}"></label><label>To<input type="time" class="d-to" value="${esc(x.to)}"></label></div>
        <p class="hint d-sum"></p>
      </div>
    </div></div>`;
}
PAGES.processes = async (main) => {
  main.innerHTML = `<div class="head"><div><h1>Processes</h1></div>
    <div class="actions"><button class="btn primary" id="addProc">+ Add process</button></div></div>
    <div class="panel"><div class="tw"><table><thead><tr><th>Process</th><th>Trunk</th><th>Customer auth</th><th>Connection</th><th>Live / limit</th><th>Calls allowed</th><th>Dummy number</th><th class="r">DIDs assigned</th><th>Status</th><th></th></tr></thead><tbody id="pBody"><tr><td colspan="10" class="empty">Loading…</td></tr></tbody></table></div></div>`;
  $('#addProc').onclick = async () => { if (!S.trunks.length) S.trunks = await api('GET', '/api/trunks'); procForm(); };
  [S.trunks] = await Promise.all([api('GET', '/api/trunks')]);
  await loadProcs();
  clearInterval(S.regTimer);   // connection status every 15 s while this page is open
  S.regTimer = setInterval(() => { if (S.page !== 'processes') clearInterval(S.regTimer); else if (!document.hidden) bg(loadRegs); }, 15000);
};
// online / offline. password auth: online = registered to us
// IP auth: online = customer server answers our OPTIONS ping (every 60 s)
function regChip(p, st) {
  if (!st) return '<span class="chip">?</span>';
  if (p.auth_type !== 'password') {
    const fixed = p.allowed_ips.split(',').filter((x) => x && !x.includes('/'));
    if (!p.active) return '<span class="chip">inactive</span>';
    if (!fixed.length) return '<span class="chip" title="Only IP ranges (CIDR) are set — there is no single IP to ping">IP range</span>';
    const r = st.reachable[p.code] || [];
    const tip = r.map((x) => `${x.ip}:${x.port}: ${x.status === 'Avail' ? `reachable${x.rtt != null ? ` · ${x.rtt} ms` : ''}` : x.status === 'Unavail' ? 'no answer to OPTIONS ping' : 'not checked yet'}`).join('\n');
    const up = r.filter((x) => x.status === 'Avail');
    if (up.length) return `<span class="chip ok" title="Online — answers our SIP OPTIONS ping\n${esc(tip)}">online</span><br><small class="mono">${esc(up[0].ip)}:${up[0].port}${up[0].rtt != null ? ` · ${up[0].rtt} ms` : ''}</small>`;
    if (r.some((x) => x.status === 'Unavail')) return `<span class="chip bad" title="Offline — ${esc(tip)}\nThe customer server does not answer SIP OPTIONS (down, firewall, or it ignores OPTIONS). Calls are not affected by this check.">offline</span>`;
    return `<span class="chip" title="Asterisk pings every 60 s — wait a minute">checking…</span>`;
  }
  const c = st.registered[p.code];
  if (!c) return `<span class="chip bad" title="Offline — ${p.active ? 'the customer server has not registered (or its registration expired)' : 'Process inactive'}">offline</span>`;
  const tip = c.map((x) => `${x.ip}${x.port ? ':' + x.port : ''}${x.userAgent ? ' · ' + x.userAgent : ''}${x.expiresIn != null ? ` · expires in ${x.expiresIn}s` : ''}`).join('\n');
  const want = +p.sip_port || 5060, other = c.find((x) => x.port && x.port !== want);
  const note = other ? `\nRegistered from port ${other.port}, the process says ${want} — calls follow the registration (${other.port}).` : '';
  return `<span class="chip ok" title="Online — registered\n${esc(tip)}${esc(note)}">online</span><br><small class="mono">${esc(c[0].ip)}${c[0].port ? ':' + c[0].port : ''}${other ? ' <b title="differs from the process port">≠ ' + want + '</b>' : ''}</small>`;
}
async function loadRegs() {   // refresh only the Registration cells
  const st = await api('GET', '/api/processes/status').catch(() => null);
  for (const p of S.processes || []) { const td = $(`#reg-${p.id}`); if (td) td.innerHTML = regChip(p, st); }
}
async function loadProcs() {
  let reg;
  [S.processes, reg] = await Promise.all([api('GET', '/api/processes'), api('GET', '/api/processes/status').catch(() => null)]);
  const live = Object.fromEntries((S.snap?.processes || []).map((p) => [p.code, p]));
  const body = $('#pBody'); if (!body) return;
  body.innerHTML = S.processes.length ? S.processes.map((p) => {
    const L = live[p.code] || { live: 0 };
    const trunkCell = p.trunk_name ? `${esc(p.trunk_name)}${p.trunk_active ? '' : ' <span class="chip bad">trunk off</span>'}` : '<span class="chip bad">no trunk</span>';
    return `<tr>
      <td class="t-name"><b>${esc(p.name)}</b><small>${esc(p.code)}</small></td>
      <td>${trunkCell}</td>
      <td>${p.auth_type === 'password' ? `<span class="chip">user</span> <span class="mono" style="font-size:12px">${esc(p.sip_username)}</span>${p.allowed_ips ? `<br><small class="mono" title="${esc(p.allowed_ips.split(',').join('\n'))}">${esc(p.allowed_ips.split(',').slice(0, 2).join(', '))}${p.allowed_ips.split(',').length > 2 ? '…' : ''}</small>` : ''}<br><small class="mono">port ${+p.sip_port || 5060}</small>`
        : `<span class="mono" style="font-size:12px" title="${esc(p.allowed_ips.split(',').join('\n'))}">${esc(p.allowed_ips.split(',').slice(0, 2).join(', ')) || '<span class="chip bad">none</span>'}${p.allowed_ips.split(',').length > 2 ? '…' : ''}</span><br><small class="mono">port ${+p.sip_port || 5060}</small>`}</td>
      <td id="reg-${p.id}">${regChip(p, reg)}</td>
      <td>${usage(L.live, p.channel_limit)}</td>
      <td><div class="dirs">${dirChip('OUT', p.allow_outbound !== false, p.out_hours)}${dirChip('IN', p.allow_inbound !== false, p.in_hours)}</div></td>
      <td class="mono" style="font-size:12.5px;white-space:nowrap">${esc(p.dummy_cli)}</td>
      <td class="r" style="white-space:nowrap">${+p.did_count ? `<b class="num">${fmtInt(+p.did_count)}</b><br><small class="mono" style="color:var(--ink-3)" title="${esc(p.inbound_dids.join('\n'))}">${esc(p.inbound_dids.slice(0, 2).join(', '))}${p.inbound_dids.length > 2 ? '…' : ''}</small>` : '<span style="color:var(--ink-3)">0</span>'}</td>
      <td>${p.active ? '<span class="chip ok">active</span>' : '<span class="chip">inactive</span>'}</td>
      <td><div class="ops">
        <button class="btn sm" data-peer="${p.id}">Peer config</button>
        <button class="btn sm" data-hlog="${p.id}">Header log</button>
        <button class="btn sm" data-limit="${p.id}">Limit</button>
        <button class="btn sm" data-edit="${p.id}">Edit</button>
        <button class="btn sm" data-toggle="${p.id}">${p.active ? 'Deactivate' : 'Activate'}</button>
        <button class="btn sm danger" data-del="${p.id}">Delete</button></div></td></tr>`;
  }).join('') : `<tr><td colspan="10" class="empty">No processes yet. Each customer Asterisk that sends you calls is a process.</td></tr>`;
  const find = (b, k) => S.processes.find((x) => x.id === +b.dataset[k]);
  $$('[data-edit]', body).forEach((b) => (b.onclick = () => procForm(find(b, 'edit'))));
  $$('[data-peer]', body).forEach((b) => (b.onclick = () => peerConfig(find(b, 'peer'))));
  $$('[data-hlog]', body).forEach((b) => (b.onclick = () => headerLog(find(b, 'hlog'))));
  $$('[data-limit]', body).forEach((b) => (b.onclick = () => limitForm(find(b, 'limit'))));
  $$('[data-toggle]', body).forEach((b) => (b.onclick = async () => {
    const p = find(b, 'toggle');
    try { applyToast(await api('POST', `/api/processes/${p.id}/active`, { active: !p.active }), 'Process'); loadProcs(); } catch (e) { toast(e.message, true); }
  }));
  $$('[data-del]', body).forEach((b) => (b.onclick = async () => {
    const p = find(b, 'del');
    if (!(await confirmBox('Delete process', `Delete <b>${esc(p.name)}</b> (${esc(p.code)})? Its calls are rejected at once and its DIDs become free. Call history is kept.`))) return;
    try { applyToast(await api('DELETE', `/api/processes/${p.id}`), 'Process'); loadProcs(); } catch (e) { toast(e.message, true); }
  }));
}
function limitForm(p) {
  const t = S.trunks.find((x) => x.id === p.trunk_id);
  openModal(`Channel limit · ${p.name}`, `<form id="lf" class="mbody" style="padding-top:12px">
    <label>Channel limit<input name="channel_limit" type="number" min="1" value="${p.channel_limit}" required></label>
    <p class="hint" style="margin-top:8px">Takes effect for the next call. Calls already up are never cut.${t && t.max_channels ? ` Trunk ${esc(t.name)} has ${t.max_channels} channels.` : ''}</p>
    <p class="err" id="lErr"></p><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save & apply</button></div></form>`,
  (c) => $('#lf', c).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { applyToast(await api('POST', `/api/processes/${p.id}/limit`, formData(e.target)), 'Limit'); closeModal(); loadProcs(); }
    catch (err) { $('#lErr').textContent = err.message; }
  }));
}
async function procForm(p) {
  const sug = await api('GET', '/api/processes/suggest');
  const v = p || { channel_limit: 10, dummy_cli: sug.dummy_cli, active: true, auth_type: 'ip', allowed_ips: '', sip_port: 5060, allow_outbound: true, allow_inbound: true };
  const byPass = v.auth_type === 'password';
  const trunkOpts = `<option value="">— no trunk (calls rejected) —</option>` + S.trunks.map((t) =>
    `<option value="${t.id}" ${v.trunk_id === t.id ? 'selected' : ''}>${esc(t.name)} · ${t.max_channels || '∞'} ch${t.active ? '' : ' (inactive)'}</option>`).join('');
  openModal(p ? `Edit process ${p.name}` : 'Add process', `<form id="pf"><div class="fgrid">
    <label>Process code <small>a-z 0-9 _ · Asterisk endpoint p_code</small><input name="code" value="${esc(v.code || '')}" required pattern="[a-z0-9_]{2,32}"></label>
    <label>Display name<input name="name" value="${esc(v.name || '')}" placeholder="Customer / campaign" required></label>
    <label>SIP trunk<select name="trunk_id">${trunkOpts}</select></label>
    <label>Channel limit <small>max concurrent calls for this customer</small><input name="channel_limit" type="number" min="1" value="${v.channel_limit}" required></label>
    <p class="hint full" id="capHint"></p>
    <div class="fsec">Customer server</div>
    <label class="full">Authentication<select name="auth_type">
      <option value="ip" ${byPass ? '' : 'selected'}>By server IP — calls accepted only from the customer's IPs</option>
      <option value="password" ${byPass ? 'selected' : ''}>Username + password — the customer registers / authenticates (any IP)</option></select></label>
    <label class="full">Customer server IPs <small class="a-ip">calls are accepted only from these IPs · comma separated, CIDR allowed · each IP belongs to one process · the first single IP receives inbound DID calls</small><small class="a-pw">optional · if set, the username is accepted only from these IPs · comma separated, CIDR allowed · blank = any IP</small><input name="allowed_ips" value="${esc(v.allowed_ips || '')}" placeholder="203.0.113.25, 198.51.100.0/28" class="mono"></label>
    <label>Customer SIP port <small class="a-ip">where inbound DID calls and the online check are sent · usually 5060</small><small class="a-pw">the port the customer server registers from · usually 5060 · calls follow the registration</small><input name="sip_port" type="number" min="1" max="65535" value="${v.sip_port || 5060}" class="mono"></label>
    <label class="a-pw">SIP username <small>blank = process code</small><input name="sip_username" value="${esc(v.sip_username || '')}" class="mono" pattern="[A-Za-z0-9_.\\-]{2,64}" autocomplete="off"></label>
    <label class="a-pw">SIP password <small>${p && p.sip_password ? 'leave as is to keep current' : '8+ chars, no spaces'}</small><div class="row"><input name="sip_password" value="${esc(v.sip_password || sug.sip_password)}" class="mono" minlength="8" autocomplete="new-password"><button type="button" class="btn" id="sugPw">Generate</button></div></label>
    <p class="hint full a-pw">Inbound DID calls go to wherever the customer is currently registered — their Asterisk must REGISTER to this server to receive them.</p>
    <div class="fsec">Calls allowed</div>
    ${dirBlock('out', 'Outbound calls', '— customer → carrier trunk', v.allow_outbound !== false, v.out_hours)}
    ${dirBlock('in', 'Inbound DID calls', '— carrier trunk → customer', v.allow_inbound !== false, v.in_hours)}
    <div class="fsec">Inbound DIDs <small style="text-transform:none;letter-spacing:0">— fallback: a call to a DID first goes to the process that last called that caller (or last used the DID) as X-DID; ticked DIDs get the rest</small></div>
    <div class="full did-pick" id="didPick"></div>
    <div class="fsec">Outbound dialing</div>
    <label>Dummy number <small>the client dials this number for every call</small><div class="row"><input name="dummy_cli" value="${esc(v.dummy_cli || '')}" class="mono" pattern="[0-9]{4,20}" required><button type="button" class="btn" id="sugCli">Suggest</button></div></label>
    <p class="hint full" id="hdrHint"></p>
    <label class="check full"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active (inactive = calls rejected with 403, logged as BLOCKED)</label>
  </div><p class="err" id="pErr"></p><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${p ? 'Save & apply' : 'Create process'}</button></div></form>`,
  (c) => {
    const f = $('#pf', c);
    const sync = () => {
      const pw = f.auth_type.value === 'password';
      $$('.a-ip', c).forEach((x) => x.classList.toggle('hidden', pw)); $$('.a-pw', c).forEach((x) => x.classList.toggle('hidden', !pw));
      f.allowed_ips.required = !pw; f.sip_password.required = pw;
      $$('.dirbox', c).forEach((b) => {
        const allow = $('.d-allow', b).checked, timed = $('.d-timed', b).checked;
        $('.d-sub', b).classList.toggle('hidden', !allow); $('.d-hours', b).classList.toggle('hidden', !timed);
        const days = $$('.daypick input:checked', b).map((x) => x.value), fr = $('.d-from', b).value, to = $('.d-to', b).value;
        $('.d-sum', b).textContent = !days.length ? 'Pick at least one day.' : `Allowed ${daysText(days)}, ${fr}–${to}${to && fr && to < fr ? ' (ends next day)' : ''}; calls outside this time are rejected (OFF_HOURS).`;
      });
      const t = S.trunks.find((x) => x.id === +f.trunk_id.value);
      const cliN = t ? (t.did_ranges || []).filter((r) => r.use_as_cli) : [];
      $('#hdrHint').className = 'hint full' + (t && !cliN.length ? ' warn' : '');
      const dn = esc(f.dummy_cli.value.trim() || '<dummy number>');
      $('#hdrHint').innerHTML = `The client dials <b class="mono">${dn}</b> with headers <span class="mono">X-DID: &lt;DID&gt;</span> and
        <span class="mono">X-Number: &lt;customer number&gt;</span> (digits, optional +). We dial X-Number on ${t ? esc(t.name) : 'the trunk'} with X-DID as caller ID,
        within this process's channel limit. Missing/bad header → NO_HEADER · DID not a caller-ID DID of ${t ? esc(t.name) : 'the trunk'} → INVALID_DID · any other dialed number → INVALID.`
        + (t && !cliN.length ? ` <b>${esc(t.name)} has no caller-ID DID range yet — every header call will be rejected.</b>` : '');
      const h = $('#capHint');
      if (!t) { h.className = 'hint full warn'; h.textContent = 'Without a trunk every call from this process is rejected (NO_ROUTE).'; return; }
      const used = S.processes.filter((x) => x.trunk_id === t.id && x.active && (!p || x.id !== p.id)).reduce((s, x) => s + x.channel_limit, 0);
      const total = used + (+f.channel_limit.value || 0);
      const over = t.max_channels && total > t.max_channels;
      h.className = 'hint full' + (over ? ' warn' : '');
      h.textContent = t.max_channels ? `${t.name}: ${total} of ${t.max_channels} channels sold to processes${over ? ' — oversubscribed: the trunk limit will reject extra calls (TRUNK_LIMIT)' : ''}.` : `${t.name} has no channel cap.`;
    };
    f.addEventListener('input', sync); f.addEventListener('change', sync); sync();
    // DID picker for the selected trunk, by range: add / remove From–To runs, All / None per trunk range, or expand a
    // range to tick single DIDs. The selection is kept as merged runs (BigInt), so big trunks never list every number.
    const pick = $('#didPick', c);
    const CHIPS_MAX = 500;   // a range can be expanded into single checkboxes up to this size
    const bi = (x) => BigInt(x);
    const pad = (n, len) => n.toString().padStart(len, '0');
    let sel = [], curTrunk, open = new Set();   // sel: [{ a, b, len }] sorted, merged
    const norm = (list) => list.slice().sort((x, y) => x.len - y.len || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0)).reduce((out, r) => {
      const l = out[out.length - 1];
      if (l && l.len === r.len && r.a <= l.b + 1n) { if (r.b > l.b) l.b = r.b; } else out.push({ ...r });
      return out;
    }, []);
    const cut = (list, r) => list.flatMap((x) => {   // list minus run r
      if (x.len !== r.len || r.b < x.a || r.a > x.b) return [x];
      const out = [];
      if (r.a > x.a) out.push({ a: x.a, b: r.a - 1n, len: x.len });
      if (r.b < x.b) out.push({ a: r.b + 1n, b: x.b, len: x.len });
      return out;
    });
    const overlap = (list, r) => list.filter((x) => x.len === r.len && x.a <= r.b && x.b >= r.a)
      .map((x) => ({ a: x.a > r.a ? x.a : r.a, b: x.b < r.b ? x.b : r.b, len: r.len }));
    const size = (list) => list.reduce((n, x) => n + (x.b - x.a + 1n), 0n);
    const label = (x) => (x.a === x.b ? pad(x.a, x.len) : `${pad(x.a, x.len)}–${pad(x.b, x.len)}`);
    const asRun = (r) => ({ a: bi(r.first_did), b: bi(r.last_did), len: r.first_did.length });
    // "1240, 1245-1250" or From/To -> runs; returns { runs, bad }
    const parse = (text) => {
      const runs = [], bad = [];
      for (const it of text.split(/[\s,;]+/).filter(Boolean)) {
        const [x, y = x] = it.replace(/\+/g, '').split(/[-–]/);
        if (!/^[0-9]{4,15}$/.test(x) || !/^[0-9]{4,15}$/.test(y) || x.length !== y.length || bi(x) > bi(y)) bad.push(it);
        else runs.push({ a: bi(x), b: bi(y), len: x.length });
      }
      return { runs, bad };
    };
    const drawDids = () => {
      const t = S.trunks.find((x) => x.id === +f.trunk_id.value);
      const ranges = t ? t.did_ranges || [] : [];
      if (!t) { pick.innerHTML = '<p class="hint">Pick a trunk to see its DIDs.</p>'; return; }
      if (!ranges.length) { pick.innerHTML = `<p class="hint">${esc(t.name)} has no DID ranges — add them on the SIP trunks page.</p>`; return; }
      const mine = (r) => p && r.process_id === p.id, other = (r) => r.process_id && !mine(r);
      const free = norm(ranges.filter((r) => !other(r)).map(asRun));   // what this process may take
      if (curTrunk !== t.id) { curTrunk = t.id; open = new Set(); sel = norm(ranges.filter(mine).map(asRun)); }
      const freeN = size(free);
      const warn = t.allow_inbound === false ? `<p class="hint warn">Inbound calls are blocked on ${esc(t.name)} — assigned DIDs only take effect when you allow inbound on the trunk.</p>` : '';
      pick.innerHTML = warn + `
        <div class="did-add">
          <label>From DID<input id="didFrom" class="mono" placeholder="${esc(ranges.find((r) => !other(r))?.first_did || 'first DID')}"></label>
          <label>To DID <small>blank = one DID</small><input id="didTo" class="mono" placeholder="last DID"></label>
          <button type="button" class="btn sm primary" id="didAdd">Add</button><button type="button" class="btn sm" id="didRem">Remove</button>
          <b id="didSum" class="did-sum"></b>
        </div>
        <p class="hint warn hidden" id="didErr"></p>
        <div class="did-sel" id="didSel"></div>
        <div class="did-ranges">${ranges.map((r, i) => {
          const n = didCount(r);
          if (other(r)) return `<div class="did-rg taken"><span class="mono">${esc(didLabel(r))}</span><small>${fmtInt(n)} DID${n === 1 ? '' : 's'} · assigned to <b>${esc(r.process_code)}</b></small></div>`;
          return `<div class="did-rg" data-i="${i}">
            <button type="button" class="tc-toggle" data-open="${i}" ${n > 1 && n <= CHIPS_MAX ? '' : 'disabled'} title="${n > CHIPS_MAX ? `more than ${CHIPS_MAX} numbers — use From / To` : 'pick single DIDs'}"><i>▸</i></button>
            <span class="mono">${esc(didLabel(r))}</span><small>${fmtInt(n)} DID${n === 1 ? '' : 's'}${r.note ? ' · ' + esc(r.note) : ''} · <b data-cnt="${i}"></b></small>
            <span class="did-rg-act"><button type="button" class="btn sm" data-all="${i}">All</button><button type="button" class="btn sm" data-none="${i}">None</button></span>
            <div class="did-chips hidden" data-chips="${i}"></div></div>`;
        }).join('')}</div>`;
      const err = (m) => { const e = $('#didErr', pick); e.textContent = m || ''; e.classList.toggle('hidden', !m); };
      const refresh = () => {
        const n = size(sel);
        $('#didSum', pick).textContent = `${fmtInt(Number(n))} selected · ${fmtInt(Number(freeN - n))} free`;
        $('#didSel', pick).innerHTML = sel.length ? sel.map((x, k) => `<span class="dsel mono">${label(x)}${x.a !== x.b ? ` <small>${fmtInt(Number(x.b - x.a + 1n))}</small>` : ''}<button type="button" data-x="${k}" aria-label="remove">×</button></span>`).join('')
          : '<span class="hint">No DIDs selected — inbound calls use the fallback (last process that used the DID / called the caller).</span>';
        $$('#didSel [data-x]', pick).forEach((b) => (b.onclick = () => { sel = cut(sel, sel[+b.dataset.x]); refresh(); }));
        ranges.forEach((r, i) => {
          const el = $(`[data-cnt="${i}"]`, pick); if (!el) return;
          const k = size(overlap(sel, asRun(r))), n = BigInt(didCount(r));
          el.textContent = k === 0n ? 'none selected' : k === n ? 'all selected' : `${fmtInt(Number(k))} selected`;
          el.className = k ? 'on' : '';
          const box = $(`[data-chips="${i}"]`, pick);
          if (box && open.has(i)) {
            const rr = asRun(r);
            if (!box.childElementCount) {
              const out = []; for (let v = rr.a; v <= rr.b; v++) out.push(pad(v, rr.len));
              box.innerHTML = out.map((d) => `<label class="dchip"><input type="checkbox" value="${d}"><span class="mono">${d}</span></label>`).join('');
              $$('input', box).forEach((cb) => (cb.onchange = () => {
                const one = { a: bi(cb.value), b: bi(cb.value), len: cb.value.length };
                sel = cb.checked ? norm([...sel, one]) : cut(sel, one); refresh();
              }));
            }
            $$('input', box).forEach((cb) => { cb.checked = overlap(sel, { a: bi(cb.value), b: bi(cb.value), len: cb.value.length }).length > 0; });
          }
        });
      };
      // add: only the parts that are free on this trunk; remove: anything
      const apply = (adding) => {
        const from = $('#didFrom', pick).value.trim(), to = $('#didTo', pick).value.trim();
        if (!from) return err('Enter a DID in From (and optionally To).');
        const { runs, bad } = parse(to ? `${from}-${to}` : from);
        if (bad.length) return err(`Not a valid DID or range: ${bad.join(', ')} — From and To must have the same number of digits.`);
        let outside = 0n;
        for (const r of runs) {
          if (adding) { const ok = overlap(free, r); outside += (r.b - r.a + 1n) - size(ok); sel = norm([...sel, ...ok]); }
          else sel = cut(sel, r);
        }
        err(outside ? `${fmtInt(Number(outside))} number(s) skipped — not on ${t.name} or assigned to another process.` : '');
        if (!outside) { $('#didFrom', pick).value = ''; $('#didTo', pick).value = ''; }
        refresh();
      };
      $('#didAdd', pick).onclick = () => apply(true);
      $('#didRem', pick).onclick = () => apply(false);
      [$('#didFrom', pick), $('#didTo', pick)].forEach((x) => (x.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(true); } }));
      $$('[data-all]', pick).forEach((b) => (b.onclick = () => { sel = norm([...sel, asRun(ranges[+b.dataset.all])]); refresh(); }));
      $$('[data-none]', pick).forEach((b) => (b.onclick = () => { sel = cut(sel, asRun(ranges[+b.dataset.none])); refresh(); }));
      $$('[data-open]', pick).forEach((b) => (b.onclick = () => {
        const i = +b.dataset.open, box = $(`[data-chips="${i}"]`, pick), on = !open.has(i);
        on ? open.add(i) : open.delete(i);
        box.classList.toggle('hidden', !on); b.closest('.did-rg').classList.toggle('open', on); refresh();
      }));
      refresh();
    };
    f.trunk_id.addEventListener('change', drawDids); drawDids();
    $('#sugCli', c).onclick = async () => { f.dummy_cli.value = (await api('GET', '/api/processes/suggest')).dummy_cli; };
    $('#sugPw', c).onclick = async () => { f.sip_password.value = (await api('GET', '/api/processes/suggest')).sip_password; };
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formData(f); d.active = f.active.checked;
      const dir = (k) => { const b = $(`.dirbox[data-dir="${k}"]`, c);
        return [$('.d-allow', b).checked, $('.d-timed', b).checked ? { days: $$('.daypick input:checked', b).map((x) => x.value), from: $('.d-from', b).value, to: $('.d-to', b).value } : null]; };
      [d.allow_outbound, d.out_hours] = dir('out'); [d.allow_inbound, d.in_hours] = dir('in');
      if (!f.trunk_id.value) d.dids = [];
      else if ($('#didSel', pick)) d.dids = sel.map((x) => (x.a === x.b ? pad(x.a, x.len) : `${pad(x.a, x.len)}-${pad(x.b, x.len)}`));
      try {
        const r = await api(p ? 'PUT' : 'POST', p ? `/api/processes/${p.id}` : '/api/processes', d);
        S.trunks = await api('GET', '/api/trunks');   // DID owners changed
        closeModal(); applyToast(r, 'Process'); await loadProcs();
        if (!p) peerConfig(S.processes.find((x) => x.id === r.id));
      } catch (err) { $('#pErr').textContent = err.message; }
    });
  });
}
async function peerConfig(p, via) {
  const c = await api('GET', `/api/processes/${p.id}/peer-config${via ? `?via=${via}` : ''}`);
  // private customer network -> our private IP; switch to the public IP if the customer reaches us over the internet
  const viaSw = c.privateIp ? `<div class="tabs" style="margin:0 0 10px"><button data-via="private" class="${c.via === 'private' ? 'on' : ''}">Private ${esc(c.privateIp)}</button><button data-via="public" class="${c.via === 'public' ? 'on' : ''}">Public ${esc(c.publicIp)}</button></div>` : '';
  openModal(`Peer config · ${p.name}`, `<div class="mbody">
    <p class="hint" style="margin-bottom:12px">Give these details to the customer. They point their Asterisk at your server; calls over ${c.limit} at once get <b>503</b>.</p>
    ${viaSw}<div class="cred">
      <span>Server</span><code>${esc(c.server)}:${c.port}</code><button class="btn sm" data-copy="${esc(c.server)}">Copy</button>
      ${c.auth_type === 'password' ? `<span>Username</span><code>${esc(c.username)}</code><button class="btn sm" data-copy="${esc(c.username)}">Copy</button>
      <span>Password</span><code>${esc(c.password)}</code><button class="btn sm" data-copy="${esc(c.password)}">Copy</button>` : `<span>Auth</span><code>by IP: ${esc(p.allowed_ips)}</code><span></span>`}
      <span>Channels</span><code>${c.limit}</code><span></span>
      <span>Calls</span><div class="dirs">${dirChip('OUT', p.allow_outbound !== false, p.out_hours)}${dirChip('IN', p.allow_inbound !== false, p.in_hours)}</div><span></span>
    </div>
    <div class="tabs"><button class="on" data-tab="pjsip">PJSIP</button><button data-tab="chan_sip">chan_sip / ViciDial</button></div>
    <div id="peerFiles"></div>
    <div class="mfoot">${c.auth_type === 'password' ? '<button class="btn danger" id="regen">Regenerate password</button>' : ''}<button class="btn" id="copyCfg">Copy all</button><button class="btn primary" data-close>Done</button></div></div>`,
  (card) => {
    let tab = 'pjsip';
    // one block per file (pjsip.conf / sip.conf + extensions.conf), each with its own Copy button
    const show = () => {
      const files = (c.files && c.files[tab]) || [{ name: '', text: c[tab] }];
      $('#peerFiles').innerHTML = files.map((f, i) => `<div class="pfile"><div class="pfile-h"><b class="mono">${esc(f.name)}</b><button class="btn sm" data-file="${i}">Copy ${esc(f.name)}</button></div><pre class="code">${esc(f.text)}</pre></div>`).join('');
      $$('#peerFiles [data-file]').forEach((b) => (b.onclick = () => copy(files[+b.dataset.file].text)));
      $$('[data-tab]', card).forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    };
    $$('[data-tab]', card).forEach((b) => (b.onclick = () => { tab = b.dataset.tab; show(); })); show();
    $$('[data-copy]', card).forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
    $$('[data-via]', card).forEach((b) => (b.onclick = () => peerConfig(p, b.dataset.via)));
    $('#copyCfg', card).onclick = () => copy(c[tab]);
    const rg = $('#regen', card);
    if (rg) rg.onclick = async () => {
      if (!(await confirmBox('Regenerate password', 'The customer must update their config — their calls fail until they do.', 'Regenerate'))) return;
      try { applyToast(await api('POST', `/api/processes/${p.id}/regenerate`), 'Password'); await loadProcs(); peerConfig(p, c.via); } catch (e) { toast(e.message, true); }
    };
  });
}
// navigator.clipboard exists only on HTTPS / localhost; the panel is usually opened as http://<ip>:3000, so fall back
// to a hidden textarea + execCommand('copy'), which works on plain HTTP too
function copy(text) {
  const legacy = () => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    ($('#modal:not(.hidden) .modal-card') || document.body).append(ta);
    ta.select(); ta.setSelectionRange(0, text.length);
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
    ta.remove();
    ok ? toast('Copied') : toast('Copy failed — select the text and press Ctrl+C', true);
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => toast('Copied'), legacy);
  else legacy();
}

// =================================================================== CDR
PAGES.cdr = async (main) => {
  const [procs, trunks] = isViewer() ? [S.me.processes, []] : await Promise.all([api('GET', '/api/processes'), api('GET', '/api/trunks')]);
  main.innerHTML = `<div class="head"><div><h1>CDR report</h1><p>Every call with its disposition. Times in ${esc(S.tz)}.</p></div></div>
    <div class="panel"><form class="filters" id="cf">
      <label>From<input type="date" name="from" value="${dayStr()}"></label>
      <label>To<input type="date" name="to" value="${dayStr()}"></label>
      <label>Process<select name="process"><option value="">All${isViewer() ? ' my processes' : ''}</option>${procs.map((p) => `<option value="${esc(p.code)}">${esc(p.code)}</option>`).join('')}</select></label>
      <label class="${isViewer() ? 'hidden' : ''}">Trunk<select name="trunk"><option value="">All</option>${trunks.map((t) => `<option>${esc(t.name)}</option>`).join('')}</select></label>
      <label>Disposition<select name="disposition"><option value="">All</option>${S.dispositions.map((d) => `<option value="${d.code}">${esc(dispName(d.code))}</option>`).join('')}</select></label>
      <label>Direction<select name="direction"><option value="">All</option><option value="out">Outbound</option><option value="in">Inbound DID</option></select></label>
      <label>Number<input name="number" placeholder="contains…" class="mono"></label>
      <label>DID<input name="did" placeholder="exact DID" class="mono"></label>
      <div class="actions"><button class="btn primary">Search</button><button type="button" class="btn" id="csv">Export CSV</button></div>
    </form><div class="summary" id="cSum"></div>
    <div class="tw"><table><thead><tr><th id="cSort" style="cursor:pointer;user-select:none;white-space:nowrap" title="Sort by call time">Call time <span id="cArrow">▼</span></th><th>Process</th><th>Trunk</th><th>Dummy link number</th><th>Customer number</th><th>Caller ID</th><th>DID</th><th>Disposition</th><th class="r">Ring</th><th class="r">Talk</th><th class="r">Cause</th></tr></thead><tbody id="cBody"></tbody></table></div>
    <div class="pager" id="cPager"></div></div>`;
  const f = $('#cf'); let page = 1, sort = 'desc';
  const qs = () => new URLSearchParams({ ...formData(f), page, sort }).toString();
  $('#cSort').onclick = () => { sort = sort === 'desc' ? 'asc' : 'desc'; $('#cArrow').textContent = sort === 'desc' ? '▼' : '▲'; page = 1; load(); };
  const load = async () => {
    $('#cBody').innerHTML = `<tr><td colspan="11" class="empty">Loading…</td></tr>`;
    try {
      const r = await api('GET', '/api/reports/calls?' + qs());
      const ans = (r.byDisposition.find((d) => d.disposition === 'ANSWERED') || {}).n || 0;
      $('#cSum').innerHTML = `<span class="chip">${fmtInt(r.total)} calls</span><span class="chip">talk ${fmtDur(r.talkSec)}</span><span class="chip">ASR ${pct(ans, r.total)}%</span>` +
        r.byDisposition.map((d) => `<span class="chip ${DISP_CLASS[d.disposition] || ''}">${esc(dispName(d.disposition))} ${fmtInt(d.n)}</span>`).join('');
      $('#cBody').innerHTML = r.rows.length ? r.rows.map((c) => `<tr>
        <td class="mono" style="font-size:12.5px;white-space:nowrap" title="${fmtTime(c.start_time)}">${fmtShort(c.start_time)}</td><td>${esc(c.process_code || '')}</td><td>${esc(c.trunk_name || '')}</td>
        <td class="mono">${c.direction === 'in' ? '<span class="chip info" title="inbound call to a DID">in</span> ' : ''}${esc(c.dialed || '')}</td><td class="mono" style="color:var(--ink-2)">${esc(c.sent_number || '')}</td>
        <td class="mono" style="font-size:12.5px"${c.cli_out ? ` title="sent to carrier as ${esc(c.cli_out)}"` : ''}>${esc(c.cli_in || '')}</td>
        <td class="mono" style="font-size:12.5px">${esc(c.did || '')}${c.hdr_status && c.hdr_status !== 'none' ? ` <span class="chip ${c.hdr_status === 'ok' ? 'ok' : 'bad'}" title="header dialing call">hdr ${esc(HDR_TXT[c.hdr_status] || c.hdr_status)}</span>` : ''}</td><td>${dispChip(c.disposition)}</td>
        <td class="r num">${c.ring_sec}s</td><td class="r num">${fmtDur(c.bill_sec)}</td><td class="r num" title="Q.850 hangup cause">${c.hangup_cause || ''}</td></tr>`).join('')
        : `<tr><td colspan="11" class="empty">No calls for this filter.</td></tr>`;
      const pages = Math.max(1, Math.ceil(r.total / r.size));
      $('#cPager').innerHTML = `Page ${page} of ${pages} <button class="btn sm" id="pv" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button><button class="btn sm" id="nx" ${page >= pages ? 'disabled' : ''}>Next ›</button>`;
      $('#pv').onclick = () => { page--; load(); }; $('#nx').onclick = () => { page++; load(); };
    } catch (e) { $('#cBody').innerHTML = `<tr><td colspan="11" class="empty">${esc(e.message)}</td></tr>`; }
  };
  f.addEventListener('submit', (e) => { e.preventDefault(); page = 1; load(); });
  $('#csv').onclick = () => { location.href = '/api/reports/calls.csv?' + qs(); };
  load();
};

// =================================================================== DAILY STATS
PAGES.stats = async (main) => {
  main.innerHTML = `<div class="head"><div><h1>Daily statistics</h1><p>Day-wise dialing count and dispositions. ASR counts only calls that reached a trunk.</p></div></div>
    <div class="panel" style="margin-bottom:14px"><form class="filters" id="sf" style="border-bottom:0">
      <label>From<input type="date" name="from" value="${daysAgo(6)}"></label>
      <label>To<input type="date" name="to" value="${dayStr()}"></label>
      <label>Group by<select name="scope"><option value="process">Process</option>${isViewer() ? '' : '<option value="trunk">Trunk</option><option value="did">DID</option>'}</select></label>
      <label>Only<select name="ref"><option value="">All</option></select></label>
      <div class="actions"><button class="btn primary">Show</button></div></form></div>
    <div class="panel" style="margin-bottom:14px"><h2>Usage over time <span class="uctl">
      <select id="uMetric" aria-label="Measure"><option value="peak">Channels in use (peak)</option><option value="calls">Calls started</option><option value="answered">Answered calls</option></select>
      <select id="uStep" aria-label="Interval"><option value="0">Auto interval</option><option value="5">5 min</option><option value="15">15 min</option><option value="60">1 hour</option><option value="1440">1 day</option></select></span></h2>
      <div class="body"><div class="legend u-legend" id="uLegend"></div><div class="rh-chart" id="uChart"></div></div></div>
    <div class="panel" style="margin-bottom:14px"><h2>Calls per day</h2><div class="body" id="sChart"></div></div>
    <div class="panel"><div class="tw"><table><thead><tr><th>Day</th><th id="refH">Process</th><th class="r">Total</th><th class="r">Answered</th><th class="r">Busy</th><th class="r">No ans.</th><th class="r">Cancel</th><th class="r">Congest.</th><th class="r">Failed</th><th class="r" title="trunk / far end unreachable">SIP down</th><th class="r" title="CHANNEL_LIMIT + TRUNK_LIMIT + BLOCKED + NO_ROUTE + INVALID + OFF_HOURS + NO_HEADER + INVALID_DID">Rejected</th><th class="r">ASR</th><th class="r">ACD</th><th class="r">Talk</th><th class="r">Peak ch</th></tr></thead><tbody id="sBody"></tbody></table></div></div>`;
  const f = $('#sf');
  const fillRefs = async () => {
    const list = f.scope.value === 'trunk' ? (await api('GET', '/api/trunks')).map((t) => t.name)
      : f.scope.value === 'did' ? []   // can be thousands: show all DIDs with calls
      : isViewer() ? S.me.processes.map((p) => p.code) : (await api('GET', '/api/processes')).map((p) => p.code);
    f.ref.innerHTML = '<option value="">All</option>' + list.map((x) => `<option>${esc(x)}</option>`).join('');
  };
  const rej = (r) => r.channel_limit + r.trunk_limit + r.blocked + r.no_route + r.invalid + (r.off_hours || 0) + (r.no_header || 0) + (r.invalid_did || 0);
  const row = (r, label) => {
    const reached = r.total - rej(r);
    return `<tr${label ? ' style="font-weight:600"' : ''}><td class="mono">${label || r.day}</td><td>${label ? '' : esc(r.ref)}</td>
      <td class="r num">${fmtInt(r.total)}</td><td class="r num">${fmtInt(r.answered)}</td><td class="r num">${fmtInt(r.busy)}</td><td class="r num">${fmtInt(r.no_answer)}</td>
      <td class="r num">${fmtInt(r.cancel)}</td><td class="r num">${fmtInt(r.congestion)}</td><td class="r num">${fmtInt(r.failed)}</td><td class="r num">${fmtInt(r.sip_down)}</td>
      <td class="r num" title="process limit (${esc(dispName('CHANNEL_LIMIT'))}) ${r.channel_limit} · trunk limit ${r.trunk_limit} · blocked ${r.blocked} · no route ${r.no_route} · invalid ${r.invalid} · off hours ${r.off_hours || 0} · no header ${r.no_header || 0} · invalid DID ${r.invalid_did || 0}">${fmtInt(rej(r))}</td>
      <td class="r num">${pct(r.answered, reached)}%</td><td class="r num">${r.answered ? fmtDur(Math.round(r.talk_sec / r.answered)) : '—'}</td>
      <td class="r num">${fmtDur(r.talk_sec)}</td><td class="r num">${fmtInt(r.peak_channels)}</td></tr>`;
  };
  let usage = null;
  const loadUsage = async () => {
    $('#uChart').innerHTML = '<p class="hint">Loading…</p>';
    usage = await api('GET', '/api/reports/usage?' + new URLSearchParams({ ...formData(f), step: $('#uStep').value }));
    usageChart($('#uChart'), $('#uLegend'), usage, $('#uMetric').value);
  };
  $('#uMetric').onchange = () => { if (usage) usageChart($('#uChart'), $('#uLegend'), usage, $('#uMetric').value); };
  $('#uStep').onchange = () => loadUsage().catch((er) => toast(er.message, true));
  const load = async () => {
    loadUsage().catch((er) => toast(er.message, true));
    const d = formData(f);
    $('#refH').textContent = { trunk: 'Trunk', did: 'DID' }[d.scope] || 'Process';
    const r = await api('GET', '/api/reports/daily?' + new URLSearchParams(d));
    const keys = ['total', 'answered', 'busy', 'no_answer', 'cancel', 'congestion', 'failed', 'sip_down', 'channel_limit', 'trunk_limit', 'blocked', 'no_route', 'invalid', 'off_hours', 'no_header', 'invalid_did', 'talk_sec'];
    const tot = Object.fromEntries(keys.map((k) => [k, r.rows.reduce((s, x) => s + +x[k], 0)]));
    tot.peak_channels = Math.max(0, ...r.rows.map((x) => x.peak_channels));
    $('#sBody').innerHTML = r.rows.length ? r.rows.map((x) => row(x)).join('') + row(tot, 'Total')
      : `<tr><td colspan="15" class="empty">No calls in this range.</td></tr>`;
    // per-day chart
    const days = []; for (let t = new Date(r.from + 'T00:00:00Z'); t <= new Date(r.to + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1)) days.push(t.toISOString().slice(0, 10));
    const by = Object.fromEntries(days.map((x) => [x, { total: 0, answered: 0, rejected: 0 }]));
    for (const x of r.rows) { const b = by[x.day]; if (b) { b.total += x.total; b.answered += x.answered; b.rejected += rej(x); } }
    chart($('#sChart'), days.slice(-31).map((x) => ({ day: x, ...by[x] })));
  };
  f.scope.addEventListener('change', fillRefs);
  f.addEventListener('submit', (e) => { e.preventDefault(); load().catch((er) => toast(er.message, true)); });
  await fillRefs(); load().catch((er) => toast(er.message, true));
};
// Daily statistics: usage over time, one line per process / trunk / DID (top 7, rest = Other).
// r = /api/reports/usage; metric = peak (channels in use) | calls | answered.
function usageChart(el, legend, r, metric) {
  const N = r.buckets, step = r.step, other = 'Other';
  // cut today's range at the current time so the line does not drop to 0 in the future
  let n = N;
  if (r.to === dayStr()) {
    const [hh, mm] = new Date().toLocaleTimeString('en-GB', { timeZone: S.tz, hour12: false }).split(':').map(Number);
    const days = Math.round((Date.parse(r.to) - Date.parse(r.from)) / 864e5);
    n = Math.min(N, Math.floor((days * 1440 + hh * 60 + mm) / step) + 1);
  }
  const names = [...r.refs]; if ([...r.conc, ...r.counts].some((x) => x.ref === '')) names.push('');
  const series = names.map((ref, i) => {
    const v = new Array(n).fill(0);
    if (metric === 'peak') {   // peak inside the bucket; a bucket with no start/end keeps the level of the one before
      const by = new Map(r.conc.filter((x) => x.ref === ref).map((x) => [x.b, x]));
      let cur = 0; for (let b = 0; b < n; b++) { const x = by.get(b); if (x) { v[b] = x.peak; cur = x.last; } else v[b] = cur; }
    } else for (const x of r.counts) if (x.ref === ref && x.b < n) v[x.b] = x[metric];
    return { name: ref || other, color: ref ? `var(--s${i + 1})` : 'var(--ink-3)', v };
  });
  const label = (b, long) => {
    const m = b * step, d = new Date(Date.parse(r.from) + Math.floor(m / 1440) * 864e5), dm = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const hm = `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return step >= 1440 ? dm : r.from === r.to && !long ? hm : `${dm} ${hm}`;
  };
  legend.innerHTML = series.length > 1 ? series.map((x) => `<span><i style="display:inline-block;width:14px;height:2px;border-radius:1px;background:${x.color};vertical-align:middle;margin-right:6px"></i>${esc(x.name)}</span>`).join('') : '';
  if (!series.length || n < 1) { el.innerHTML = '<p class="hint">No calls in this range.</p>'; return; }
  const direct = series.length > 1 && series.length <= 4;
  const W = 900, H = 240, L = 46, R = direct ? 96 : 12, T = 10, B = 24;
  const top = Math.max(1, ...series.flatMap((x) => x.v));
  const mag = 10 ** Math.floor(Math.log10(top / 4)), tick = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k * 4 >= top) || mag * 10, max = Math.max(4, tick * 4);
  const x = (b) => L + (n === 1 ? (W - L - R) / 2 : (b / (n - 1)) * (W - L - R)), y = (v) => T + (1 - v / max) * (H - T - B);
  let s = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-label="${esc($('#uMetric').selectedOptions[0].text)} over time">`;
  for (let i = 0; i <= 4; i++) { const v = (max / 4) * i; s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="var(--ink-3)" font-family="var(--mono)">${fmtInt(v)}</text>`; }
  const ticks = Math.min(n, 8);
  for (let i = 0; i < ticks; i++) { const b = ticks === 1 ? 0 : Math.round((i * (n - 1)) / (ticks - 1)); s += `<text x="${x(b)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle'}" font-size="10" fill="var(--ink-3)" font-family="var(--mono)">${label(b)}</text>`; }
  for (const sr of [...series].reverse()) s += n === 1 ? `<circle cx="${x(0)}" cy="${y(sr.v[0])}" r="4" fill="${sr.color}"/>`
    : `<path d="${sr.v.map((v, b) => `${b ? 'L' : 'M'}${x(b).toFixed(1)},${y(v).toFixed(1)}`).join('')}" fill="none" stroke="${sr.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  if (direct) {   // end labels, nudged apart so they do not overlap
    const ends = series.map((sr) => ({ sr, ly: y(sr.v[n - 1]) })).sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < ends.length; i++) ends[i].ly = Math.max(ends[i].ly, ends[i - 1].ly + 12);
    ends[ends.length - 1].ly = Math.min(ends[ends.length - 1].ly, H - B - 6);
    for (let i = ends.length - 2; i >= 0; i--) ends[i].ly = Math.min(ends[i].ly, ends[i + 1].ly - 12);
    for (const e of ends) s += `<text x="${W - R + 6}" y="${e.ly + 3.5}" font-size="11" fill="var(--ink-2)">${esc(e.sr.name.length > 13 ? e.sr.name.slice(0, 12) + '…' : e.sr.name)}</text>`;
  }
  s += `<line class="rh-x" y1="${T}" y2="${H - B}" stroke="var(--ink-3)" stroke-dasharray="2 3" visibility="hidden"/>
    ${series.map((sr) => `<circle class="u-dot" r="4" fill="${sr.color}" stroke="var(--panel)" stroke-width="2" visibility="hidden"/>`).join('')}
    <rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/></svg><div class="rh-tip u-tip hidden"></div>`;
  el.innerHTML = s;
  const svg = el.firstChild, line = svg.querySelector('.rh-x'), dots = [...svg.querySelectorAll('.u-dot')], tip = el.querySelector('.u-tip');
  svg.addEventListener('pointermove', (e) => {
    const bx = svg.getBoundingClientRect(), px = ((e.clientX - bx.left) / bx.width) * W;
    const b = n === 1 ? 0 : Math.min(n - 1, Math.max(0, Math.round(((px - L) / (W - L - R)) * (n - 1))));
    line.setAttribute('x1', x(b)); line.setAttribute('x2', x(b)); line.setAttribute('visibility', 'visible');
    series.forEach((sr, i) => { dots[i].setAttribute('cx', x(b)); dots[i].setAttribute('cy', y(sr.v[b])); dots[i].setAttribute('visibility', 'visible'); });
    tip.innerHTML = `<div style="margin-bottom:2px">${label(b, true)}${step < 1440 ? ` <span style="color:var(--ink-3)">+${step >= 60 ? step / 60 + ' h' : step + ' min'}</span>` : ''}</div>` +
      series.map((sr) => `<div><i style="display:inline-block;width:10px;height:2px;background:${sr.color};vertical-align:middle;margin-right:6px"></i><b class="num">${fmtInt(sr.v[b])}</b> ${esc(sr.name)}</div>`).join('');
    tip.classList.remove('hidden');
    const sx = (x(b) / W) * bx.width;
    tip.style.left = `${sx > bx.width / 2 ? sx - tip.offsetWidth - 12 : sx + 12}px`;
  });
  svg.addEventListener('pointerleave', () => { line.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); tip.classList.add('hidden'); });
}
// System page: history of one resource in a modal. key = cpu | mem | disk:<mount>
function resourceGraph(key, title) {
  const get = key === 'cpu' ? (p) => p.cpu : key === 'mem' ? (p) => p.mem : ((m) => (p) => p.disks[m])(key.slice(5));
  const RANGES = [[6, '6 h'], [24, '24 h'], [72, '3 days'], [120, '5 days']];
  openModal(`${title} — history`, `<div class="mbody"><div class="tabs" id="rgTabs">${RANGES.map(([h, l]) => `<button data-h="${h}" class="${h === 24 ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="rh-lab">${esc(title)} <b class="num" data-cur></b></div><div class="rh-chart" id="rgChart">Loading…</div>
    <p class="hint" style="margin-top:8px">One sample per minute (CPU = average over the minute), kept 5 days. Longer ranges show averages.</p></div>`, (card) => {
    let hours = 24;
    const load = async () => {
      const r = await api('GET', `/api/system/resources/history?hours=${hours}`);
      const el = $('#rgChart', card); if (!el) return;
      if (r.points.filter((p) => get(p) != null).length < 2) { el.innerHTML = '<p class="hint">Collecting — not enough samples for this range yet.</p>'; return; }
      lineChart(el, r.points, get, hours * 3600000);
    };
    $('#rgTabs', card).onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $$('#rgTabs button', card).forEach((x) => x.classList.toggle('on', x === b));
      hours = +b.dataset.h; load().catch((er) => toast(er.message, true));
    };
    load().catch((er) => { $('#rgChart', card).textContent = er.message; });
  });
}

// % line over time (0–100, one axis), crosshair + tooltip on hover. get(point) -> value or undefined (gap).
function lineChart(el, pts, get, spanMs) {
  const W = 520, H = 150, L = 34, R = 8, T = 8, B = 20, end = Date.now(), start = end - spanMs;
  const x = (t) => L + ((t - start) / spanMs) * (W - L - R), y = (v) => T + (1 - Math.min(100, Math.max(0, v)) / 100) * (H - T - B);
  const step = Math.max(...pts.slice(1).map((p, i) => p.at - pts[i].at).sort((a, b) => a - b).slice(0, 1), 60000);
  let d = '', prev = null;
  for (const p of pts) {   // break the line where samples are missing (service down)
    const v = get(p); if (v == null) { prev = null; continue; }
    d += `${prev && p.at - prev.at <= step * 3 ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(v).toFixed(1)}`; prev = p;
  }
  const fmtT = (t, long) => new Date(t).toLocaleString([], long ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : spanMs > 864e5 ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' });
  let s = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img">`;
  for (const v of [0, 50, 100]) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="var(--ink-3)" font-family="var(--mono)">${v}%</text>`;
  for (let i = 0; i <= 4; i++) { const t = start + (spanMs * i) / 4; s += `<text x="${x(t)}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}" font-size="10" fill="var(--ink-3)" font-family="var(--mono)">${fmtT(t)}</text>`; }
  s += `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <line class="rh-x" y1="${T}" y2="${H - B}" stroke="var(--ink-3)" stroke-dasharray="2 3" visibility="hidden"/>
    <circle class="rh-dot" r="4" fill="var(--accent)" stroke="var(--panel)" stroke-width="2" visibility="hidden"/>
    <rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/></svg><div class="rh-tip hidden"></div>`;
  el.innerHTML = s;
  const live = [...pts].reverse().find((p) => get(p) != null);
  const cur = el.parentElement.querySelector('[data-cur]'); if (cur && live) cur.textContent = `${get(live)}%`;
  const svg = el.firstChild, line = svg.querySelector('.rh-x'), dot = svg.querySelector('.rh-dot'), tip = el.querySelector('.rh-tip');
  svg.addEventListener('pointermove', (e) => {
    const b = svg.getBoundingClientRect(), t = start + (((e.clientX - b.left) / b.width) * W - L) / (W - L - R) * spanMs;
    let best = null; for (const p of pts) if (get(p) != null && (!best || Math.abs(p.at - t) < Math.abs(best.at - t))) best = p;
    if (!best) return;
    const px = x(best.at), py = y(get(best));
    line.setAttribute('x1', px); line.setAttribute('x2', px); dot.setAttribute('cx', px); dot.setAttribute('cy', py);
    line.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b class="num">${get(best)}%</b> <span>${fmtT(best.at, true)}</span>`;
    tip.classList.remove('hidden');
    tip.style.left = `${Math.min(Math.max(0, (px / W) * b.width - tip.offsetWidth / 2), b.width - tip.offsetWidth)}px`;
  });
  svg.addEventListener('pointerleave', () => { line.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.classList.add('hidden'); });
}
function chart(el, data) {
  const W = 900, H = 200, pad = 28, top = Math.max(4, ...data.map((d) => d.total)), step = Math.ceil(top / 4), max = step * 4;
  const bw = (W - pad * 2) / data.length;
  let s = `<svg viewBox="0 0 ${W} ${H + 24}" style="width:100%;height:auto;display:block" role="img" aria-label="Calls per day">`;
  for (let i = 0; i <= 4; i++) { const y = pad / 2 + ((H - pad) * i) / 4; s += `<line x1="${pad}" x2="${W - 8}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${pad - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--ink-3)" font-family="var(--mono)">${fmtInt(max - step * i)}</text>`; }
  data.forEach((d, i) => {
    const x = pad + i * bw + bw * 0.18, w = bw * 0.64, sc = (v) => ((H - pad) * v) / max, base = H - pad / 2;
    s += `<g><title>${d.day}: ${d.total} calls, ${d.answered} answered, ${d.rejected} rejected</title>
      <rect x="${x}" y="${base - sc(d.total)}" width="${w}" height="${sc(d.total)}" rx="2" fill="var(--line-2)"/>
      <rect x="${x}" y="${base - sc(d.answered)}" width="${w}" height="${sc(d.answered)}" rx="2" fill="var(--accent)"/></g>`;
    if (data.length <= 16 || i % Math.ceil(data.length / 12) === 0) s += `<text x="${x + w / 2}" y="${H + 14}" text-anchor="middle" font-size="10" fill="var(--ink-3)" font-family="var(--mono)">${d.day.slice(5)}</text>`;
  });
  el.innerHTML = s + `</svg><div class="legend" style="padding:6px 0 0"><span style="color:var(--accent)">■ answered</span><span>■ other dispositions</span></div>`;
}

// =================================================================== DISPOSITIONS
// What each disposition means and what to check (also used by Diagnostics → Call lookup)
const DISP_HELP = {
  ANSWERED: 'Call answered.',
  BUSY: 'Called party busy (SIP 486 from the carrier).',
  NO_ANSWER: 'Rang until the dial timeout, or the carrier gave 408/480.',
  CANCEL: 'The caller hung up before answer.',
  CONGESTION: 'Carrier answered 503 / congestion. Check carrier capacity and the reply in a SIP trace.',
  FAILED: 'Other failure. Look at the hangup cause and a SIP trace.',
  SIP_DOWN: 'The trunk (or, inbound, the customer server) could not be reached: qualify failed or no reply. Check IP/port, firewall and the trunk state.',
  CHANNEL_LIMIT: 'The process already had its channel limit of calls up. Raise the limit or lower customer concurrency.',
  TRUNK_LIMIT: 'The trunk max channels was full, or the trunk CPS limit stayed full for 3 s.',
  BLOCKED: 'Process inactive, or this call direction is switched off for it.',
  NO_ROUTE: 'No active trunk for the process / no process for the inbound DID.',
  INVALID: 'Dialed number is not the process dummy number (outbound) or DID not on the trunk (inbound).',
  OFF_HOURS: 'Outside the process working time.',
  NO_HEADER: 'X-DID / X-Number header missing or not digits. Fix the customer dialplan.',
  INVALID_DID: 'X-DID is not a caller-ID DID of the trunk.',
};
const Q850 = { 1: 'unallocated number', 3: 'no route to destination', 16: 'normal clearing', 17: 'user busy', 18: 'no user responding',
  19: 'no answer', 20: 'subscriber absent', 21: 'call rejected', 27: 'destination out of order', 28: 'invalid number format',
  31: 'normal, unspecified', 34: 'no circuit available', 38: 'network out of order', 41: 'temporary failure', 42: 'switching equipment congestion',
  44: 'requested channel not available', 58: 'bearer capability not available', 102: 'timer expired', 127: 'interworking' };

PAGES.dispositions = async (main) => {
  main.innerHTML = `<div class="head"><div><h1>Dispositions</h1><p>Give any disposition your own code (shown in CDR, CSV, stats and the live feed) and choose the SIP response the customer gets when the distributor rejects a call.</p></div></div>
    <div class="panel"><div class="tw"><table><thead><tr><th>Internal code</th><th>Shown as</th><th>Label</th><th>Set by</th><th>SIP response</th><th>Meaning</th><th></th></tr></thead><tbody id="dBody"></tbody></table></div></div>
    <div class="panel"><h2>ISDN cause rules</h2>
      <p class="hint">Unanswered calls: the hangup cause (Q.850) and the call status decide the disposition. <b>ANY</b> = CANCEL, NOANSWER, BUSY or CONGESTION; a rule for the exact status wins over ANY. CHANUNAVAIL stays SIP_DOWN unless a rule names it. No rule = the status as reported. Answered calls and the distributor's own rejects are never changed. Applies to new calls.</p>
      <div class="tw"><table><thead><tr><th>ISDN cause</th><th>Call status</th><th>Disposition</th><th></th></tr></thead><tbody id="crBody"></tbody></table></div>
      <div class="mfoot" style="justify-content:space-between"><button type="button" class="btn sm" id="crAdd">+ Add rule</button>
        <span><span class="err" id="crErr"></span> <button type="button" class="btn primary" id="crSave">Save rules</button></span></div></div>`;
  const load = async () => {
    const r = await api('GET', '/api/dispositions');
    S.dispositions = r.rows;
    $('#dBody').innerHTML = r.rows.map((d) => `<tr>
      <td class="mono">${esc(d.code)}</td><td>${dispChip(d.code)}</td><td>${esc(d.label)}</td>
      <td><span class="chip ${d.source === 'distributor' ? 'info' : ''}">${esc(d.source)}</span></td>
      <td class="num">${d.sip_code || ''}${d.source === 'trunk' ? ' <small style="color:var(--ink-3)">from far end</small>' : ''}</td>
      <td style="font-size:12.5px;color:var(--ink-2);max-width:380px">${esc(DISP_HELP[d.code] || '')}</td>
      <td class="r"><button class="btn sm" data-edit="${esc(d.code)}">Edit</button></td></tr>`).join('');
    $$('[data-edit]').forEach((b) => (b.onclick = () => edit(r.rows.find((x) => x.code === b.dataset.edit), r.sipCodes)));
    causeRules(r);
  };
  // ISDN cause -> disposition rules: rows edited in place, the whole list is saved at once
  const causeRules = (r) => {
    const body = $('#crBody');
    const opts = (list, sel) => list.map((x) => `<option ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('');
    const row = (x = { status: 'ANY', disposition: 'NO_ANSWER' }) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><input class="mono cr-cause" type="number" min="1" max="127" value="${x.cause || ''}" style="width:90px" required></td>
        <td><select class="cr-status">${opts(r.causeStatuses, x.status)}</select></td>
        <td><select class="cr-disp">${opts(r.causeTargets, x.disposition)}</select></td>
        <td class="r"><button type="button" class="btn sm danger" title="Remove">✕</button></td>`;
      $('button', tr).onclick = () => tr.remove();
      body.appendChild(tr);
      return tr;
    };
    body.innerHTML = '';
    r.causeRules.forEach((x) => row(x));
    $('#crAdd').onclick = () => $('.cr-cause', row()).focus();
    $('#crSave').onclick = async () => {
      $('#crErr').textContent = '';
      const rules = $$('#crBody tr').map((tr) => ({ cause: $('.cr-cause', tr).value.trim(), status: $('.cr-status', tr).value, disposition: $('.cr-disp', tr).value }));
      try { const res = await api('PUT', '/api/dispositions/cause-rules', { rules }); toast(`${res.rules} cause rules saved`); load(); }
      catch (e) { $('#crErr').textContent = e.message; }
    };
  };
  const edit = (d, sipCodes) => openModal(`Disposition ${d.code}`, `<form class="mbody" id="df">
      <label>Shown as <small>custom code, A-Z 0-9 _ (empty = ${esc(d.code)})</small><input name="custom_code" class="mono" maxlength="16" value="${esc(d.custom_code || '')}" placeholder="${esc(d.code)}" style="text-transform:uppercase"></label>
      <label>Label<input name="label" maxlength="64" value="${esc(d.label)}"></label>
      ${d.source === 'distributor' ? `<label>SIP response to the customer <small>changing it re-applies the dialplan</small><select name="sip_code">${sipCodes.map((c) => `<option ${c === d.sip_code ? 'selected' : ''}>${c}</option>`).join('')}</select></label>` : ''}
      <p class="err" id="dErr"></p><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
    (c) => $('#df', c).addEventListener('submit', async (e) => {
      e.preventDefault();
      try { const r = await api('PUT', `/api/dispositions/${d.code}`, formData(e.target)); closeModal(); r.apply ? applyToast(r, 'Disposition') : toast('Disposition saved'); load(); }
      catch (er) { $('#dErr').textContent = er.message; }
    }));
  await load();
};

// =================================================================== DIAGNOSTICS
const Diag = { tab: 'issues', timer: null, names: {} };
const DIAG_TABS = [['issues', 'Issues'], ['reg', 'Registrations'], ['sip', 'SIP trace'], ['rtp', 'RTP / audio'], ['pcap', 'Packet capture'], ['log', 'Asterisk log'], ['lookup', 'Call lookup']];
const ago = (ms) => fmtDur(Math.max(0, Math.round((Date.now() - ms) / 1000)));
const durBetween = (a, b) => fmtDur(Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000)));
// ip[:port] -> "trunk x" / "proc y" / "SIPDist"
const epName = (ep) => { const ip = String(ep).replace(/:\d+$/, ''); return Diag.names[ip] || ''; };
function diagPoll(fn, ms) {
  clearInterval(Diag.timer);
  const tab = Diag.tab;
  Diag.timer = setInterval(() => { if (S.page !== 'diag' || Diag.tab !== tab || document.hidden) return; bg(fn).catch(() => {}); }, ms);
}

PAGES.diag = async (main) => {
  const want = (location.hash.split('?')[1] || '').replace(/^tab=/, '');
  if (DIAG_TABS.some(([k]) => k === want)) Diag.tab = want;
  main.innerHTML = `<div class="head"><div><h1>Diagnostics</h1><p>Find SIP and call problems: open issues, live SIP trace (like sngrep), RTP / audio quality, tcpdump capture, Asterisk log.</p></div></div>
    <div class="tabs big" id="dTabs">${DIAG_TABS.map(([k, l]) => `<button data-t="${k}">${l}</button>`).join('')}</div><div id="dBodyMain"></div>`;
  try {
    const [tr, pr] = await Promise.all([api('GET', '/api/trunks'), api('GET', '/api/processes')]);
    Diag.names = {}; Diag.trunks = tr; Diag.procs = pr;
    for (const p of pr) for (const ip of String(p.allowed_ips || '').split(/[\s,]+/).filter((x) => x && !x.includes('/'))) Diag.names[ip] = `proc ${p.code}`;
    for (const t of tr) Diag.names[t.host] = `trunk ${t.name}`;
    if (S.me.publicIp) Diag.names[S.me.publicIp] = 'SIPDist';
  } catch { /* names are cosmetic */ }
  const show = (k) => {
    Diag.tab = k; clearInterval(Diag.timer);
    $$('#dTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === k));
    history.replaceState(null, '', `#/diag?tab=${k}`);
    DiagTab[k]($('#dBodyMain')).catch((e) => toast(e.message, true));
  };
  $$('#dTabs button').forEach((b) => (b.onclick = () => show(b.dataset.t)));
  show(Diag.tab);
};

const DiagTab = {};

// Trunk / process / custom IP picker used by the SIP trace, RTP capture and packet capture forms
function targetField() {
  const tr = Diag.trunks || [], pr = Diag.procs || [];
  return `<label class="tgt">Trunk / process<select name="target"><option value="">All traffic</option>
      ${tr.length ? `<optgroup label="SIP trunks">${tr.map((t) => `<option value="trunk:${esc(t.name)}">trunk ${esc(t.name)} — ${esc(t.host)}</option>`).join('')}</optgroup>` : ''}
      ${pr.length ? `<optgroup label="Processes">${pr.map((p) => `<option value="process:${esc(p.code)}">process ${esc(p.code)} — ${esc(p.name)}</option>`).join('')}</optgroup>` : ''}
      <option value="ip">Custom IP…</option></select><small class="tgtIps mono"></small></label>
    <label class="tgtHost hidden">IP / CIDR<input name="host" class="mono" placeholder="e.g. 203.0.113.5"></label>`;
}
// wire the picker in form f: show the custom IP box and the resolved IPs
function targetWire(f) {
  const sel = f.target, box = $('.tgtHost', f), out = $('.tgtIps', f);
  const show = async () => {
    box.classList.toggle('hidden', sel.value !== 'ip');
    out.textContent = ''; out.classList.remove('bad');
    if (!sel.value || (sel.value === 'ip' && !f.host.value.trim())) return;
    try { const r = await api('GET', '/api/diag/target?' + new URLSearchParams({ target: sel.value, host: f.host.value.trim() })); out.textContent = r.hosts.join(', '); }
    catch (e) { out.textContent = e.message; out.classList.add('bad'); }
  };
  sel.addEventListener('change', show); f.host.addEventListener('change', show);
}

// ---------------------------------------------------------------- issues
DiagTab.issues = async (el) => {
  el.innerHTML = `<div class="panel" style="margin-bottom:14px"><h2>Open issues <span><button class="btn sm" id="iRun">Run checks now</button></span></h2><div class="body" id="iOpen">Loading…</div></div>
    <div class="panel"><h2>Issue history</h2><div class="tw" style="max-height:440px;overflow:auto"><table><thead><tr><th>Severity</th><th>Issue</th><th>Detail</th><th>Opened</th><th>Closed</th><th class="r">Lasted</th></tr></thead><tbody id="iHist"></tbody></table></div></div>`;
  const draw = (r) => {
    $('#iOpen').innerHTML = r.open.length ? r.open.map((i) => `<div class="issue ${i.severity}">
        <div class="ih"><span class="chip ${i.severity === 'critical' ? 'bad' : 'warn'}">${esc(i.severity)}</span><b>${esc(i.title)}</b><span class="when">open ${ago(new Date(i.opened_at))} · since ${fmtTime(i.opened_at)}</span></div>
        <div class="id">${esc(i.detail || '')}</div>${i.hint ? `<div class="ihint">→ ${esc(i.hint)}</div>` : ''}</div>`).join('')
      : `<div class="allgood"><span class="chip ok">OK</span> No open issues. Checks run every 30 s${r.lastRun ? ` · last ${clock(r.lastRun)}` : ''}.</div>`;
    $('#iOpen').insertAdjacentHTML('beforeend', `<p class="hint" style="margin-top:10px">Slack notifications for these issues: <a href="#/alerts">Alerts page</a>.</p>`);
    $('#iHist').innerHTML = r.history.length ? r.history.map((i) => `<tr><td><span class="chip ${i.severity === 'critical' ? 'bad' : 'warn'}">${esc(i.severity)}</span></td>
      <td>${esc(i.title)}</td><td style="font-size:12.5px;color:var(--ink-2)">${esc(i.detail || '')}</td>
      <td class="mono" style="font-size:12px;white-space:nowrap">${fmtTime(i.opened_at)}</td><td class="mono" style="font-size:12px;white-space:nowrap">${fmtTime(i.closed_at)}</td>
      <td class="r num">${durBetween(i.opened_at, i.closed_at)}</td></tr>`).join('') : `<tr><td colspan="6" class="empty">No closed issues yet.</td></tr>`;
  };
  const load = async () => draw(await api('GET', '/api/diag/issues'));
  $('#iRun').onclick = async () => { $('#iRun').disabled = true; try { draw(await api('POST', '/api/diag/issues/run')); toast('Checks done'); } finally { $('#iRun').disabled = false; } };
  await load(); diagPoll(load, 15000);
};

// ---------------------------------------------------------------- registrations
const REG_CLS = { REGISTERED: 'ok', 'NOT USED': '', 'NOT REGISTERED': 'bad', 'NOT LOADED': 'bad', REJECTED: 'bad', UNREGISTERED: 'warn' };
const fmtLeft = (s) => (s == null || !isFinite(s) ? '—' : s <= 0 ? 'expired' : fmtDur(s));
DiagTab.reg = async (el) => {
  el.innerHTML = `<div class="panel"><h2>SIP registrations <span><button class="btn sm" id="rgRef">Refresh</button></span></h2>
    <div class="summary" id="rgSum"></div>
    <div class="tw"><table><thead><tr><th>Trunk / process</th><th>Account</th><th>State</th><th class="r">Expires in</th><th>Registered from</th><th>Last log line</th><th>Last packet (trace)</th><th></th></tr></thead><tbody id="rgBody"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody></table></div>
    <div class="body"><p class="hint"><b>Outgoing</b> = this server registers to the carrier: needs "Register" on <i>and</i> a username/password on the trunk.
      <b>Incoming</b> = the customer registers to this server: only processes with password authentication. Click <b>Trace REGISTER</b> to watch the REGISTER / 401 / 200 packets live.</p></div></div>`;
  const load = async () => {
    const r = await api('GET', '/api/diag/registrations');
    const n = (f) => r.rows.filter(f).length;
    $('#rgSum').innerHTML = `<span class="chip ok">${n((x) => x.state === 'REGISTERED')} registered</span>` +
      `<span class="chip ${n((x) => x.expected && x.state !== 'REGISTERED') ? 'bad' : ''}">${n((x) => x.expected && x.state !== 'REGISTERED')} failing</span>` +
      `<span class="chip">${n((x) => !x.expected)} not using registration</span><span class="chip">updated ${clock(r.at)}</span>`;
    $('#rgBody').innerHTML = r.rows.length ? r.rows.map((x, i) => `<tr>
      <td style="white-space:nowrap"><b>${esc(x.kind)} ${esc(x.name)}</b>${x.label ? ` <small style="color:var(--ink-3)">${esc(x.label)}</small>` : ''}<br>
        <span class="chip ${x.direction === 'out' ? 'info' : ''}" style="margin-top:4px" title="${x.direction === 'out' ? 'this server registers to the carrier' : 'customer registers to this server'}">${x.direction === 'out' ? 'outgoing ↗' : 'incoming ↙'}</span></td>
      <td class="mono" style="font-size:12.5px">${esc(x.who)}${x.serverUri ? `<br><small>${esc(x.serverUri)}</small>` : ''}</td>
      <td style="min-width:220px"><span class="chip ${x.state in REG_CLS ? REG_CLS[x.state] : 'bad'}">${esc(x.state)}</span>${x.why ? `<div class="hint" style="margin-top:4px">${esc(x.why)}</div>` : ''}</td>
      <td class="r num">${x.state === 'REGISTERED' ? fmtLeft(x.expiresIn) : '—'}</td>
      <td class="mono" style="font-size:12px">${x.contacts.length ? x.contacts.map((c) => `${esc(c.ip)}${c.port ? ':' + c.port : ''}${c.userAgent ? `<br><small>${esc(c.userAgent)}</small>` : ''}`).join('<br>') : '—'}</td>
      <td style="max-width:260px">${x.lastLog ? `<div class="mono logline ${LOG_CLS[x.lastLog.level] || ''}" title="${esc(x.lastLog.line)}">${esc(x.lastLog.line)}</div>` : '<span class="hint">—</span>'}</td>
      <td class="mono" style="font-size:12px">${x.lastPacket ? `<span class="chip ${/^2/.test(x.lastPacket.label) ? 'ok' : /^[3-6]/.test(x.lastPacket.label) ? 'bad' : ''}">${esc(x.lastPacket.label)}</span><br><small>${esc(clock(x.lastPacket.ts))} ${esc(x.lastPacket.src)} → ${esc(x.lastPacket.dst)}</small>` : '<span class="hint">no trace data</span>'}</td>
      <td class="r" style="white-space:nowrap"><button class="btn sm" data-trace="${i}">Trace REGISTER</button></td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">No trunks or processes.</td></tr>';
    $$('[data-trace]').forEach((b) => (b.onclick = async () => {
      const x = r.rows[+b.dataset.trace];
      try {
        await api('POST', '/api/diag/sip/start', { target: x.target, minutes: 10 });
        Diag.sipPreset = { types: ['register'] };
        toast(`Tracing ${x.kind} ${x.name} — showing REGISTER packets`);
        $('#dTabs [data-t=sip]').click();
      } catch (er) { toast(er.message, true); }
    }));
  };
  $('#rgRef').onclick = () => load().catch((e) => toast(e.message, true));
  await load(); diagPoll(load, 5000);
};

// ---------------------------------------------------------------- SIP trace (sngrep-like)
const STATE_CLS = { 'IN CALL': 'ok', COMPLETED: 'ok', RINGING: 'info', 'CALL SETUP': 'info', REJECTED: 'bad', CANCELLED: 'warn', 'NO REPLY': 'bad' };
DiagTab.sip = async (el) => {
  el.innerHTML = `<div class="panel" style="margin-bottom:14px"><form class="filters" id="stf">
      ${targetField()}
      <label>Run for<select name="minutes"><option value="5">5 min</option><option value="10" selected>10 min</option><option value="30">30 min</option><option value="60">60 min</option></select></label>
      <label class="check" style="max-width:none" title="Live messages always show REGISTER / OPTIONS; this adds them to the Calls list too"><input type="checkbox" name="keepNoise" checked> REGISTER/OPTIONS in Calls</label>
      <div class="actions"><button class="btn primary" id="stGo">Start trace</button><button type="button" class="btn" id="stStop">Stop</button><button type="button" class="btn" id="stClr">Clear</button></div>
    </form><div class="summary" id="stSum"></div>
    <div class="tabs sub" id="stView"><button data-v="live">Live messages <small>INVITE · 100 · 180 · 200 · BYE · REGISTER…</small></button><button data-v="calls">Calls <small>one row per call, like sngrep</small></button></div>
    <div id="vLive">
      <div class="filters live-f">
        <span class="seg">${[['call', 'Calls (INVITE/ACK/BYE/CANCEL)', 1], ['register', 'REGISTER', 1], ['options', 'OPTIONS', 1], ['other', 'Other', 1]]
          .map(([v, l, on]) => `<label class="check"><input type="checkbox" class="lt" value="${v}" ${on ? 'checked' : ''}> ${l}</label>`).join('')}</span>
        <label style="max-width:260px">Search<input id="lmQ" class="mono" placeholder="number, Call-ID, IP, any text"></label>
        <span class="seg"><label class="check"><input type="checkbox" id="lmFull"> full text <small>like tcpdump -A</small></label>
          <label class="check"><input type="checkbox" id="lmScroll" checked> auto-scroll</label></span>
        <div class="actions"><button type="button" class="btn sm" id="lmPause">Pause</button><button type="button" class="btn sm" id="lmEmpty">Clear view</button></div>
      </div>
      <div class="lmhidden hidden" id="lmHidden"></div>
      <div class="lmhead"><span>Time</span><span>From → To</span><span>Message</span><span>CSeq</span><span>From user → To user</span><span>Call-ID</span></div>
      <div class="lmlist" id="lmList"><div class="empty">Start a trace: every SIP request and response shows up here as it happens.</div></div>
    </div>
    <div id="vCalls" class="hidden">
    <div class="filters" style="border-bottom:1px solid var(--line)"><label style="max-width:320px">Search <input id="stQ" class="mono" placeholder="number, DID, Call-ID, IP"></label>
      <label style="max-width:160px">Method<select id="stM"><option value="">All</option><option>INVITE</option><option>REGISTER</option><option>OPTIONS</option></select></label></div>
    <div class="tw" style="max-height:420px;overflow:auto"><table><thead><tr><th>Start</th><th>Method</th><th>From</th><th>To</th><th>Source</th><th>Destination</th><th class="r">Msgs</th><th>State</th><th>Codecs</th></tr></thead><tbody id="stBody"></tbody></table></div></div></div>
    <div id="stFlow"></div>`;
  const f = $('#stf'); targetWire(f);
  const status = (st) => {
    const err = st.error ? `<span class="chip bad" style="white-space:normal">${esc(st.error)}</span>` : '';
    $('#stSum').innerHTML = (st.running ? `<span class="chip ok">● capturing</span><span class="chip">until ${clock(st.until)}</span>` : `<span class="chip">stopped</span>`) +
      (st.label ? `<span class="chip info">${esc(st.label)}</span>` : '') +
      `<span class="chip mono">${esc(st.filter || 'no trace yet')}</span><span class="chip">${fmtInt(st.packets)} packets</span><span class="chip">${fmtInt(st.messages || 0)} messages</span><span class="chip">${fmtInt(st.dialogs)} calls</span>${err}`;
    $('#stGo').textContent = st.running ? 'Restart trace' : 'Start trace';
  };
  let sel = null;
  const load = async () => {
    const r = await api('GET', '/api/diag/sip/dialogs?' + new URLSearchParams({ q: $('#stQ').value.trim(), method: $('#stM').value }));
    status(r.status);
    $('#stBody').innerHTML = r.dialogs.length ? r.dialogs.map((d) => `<tr class="click ${d.callId === sel ? 'sel' : ''}" data-id="${esc(d.callId)}">
      <td class="mono" style="font-size:12px;white-space:nowrap">${clock(d.start)}</td><td>${esc(d.method)}</td>
      <td class="mono">${esc(d.from)}</td><td class="mono">${esc(d.to)}${d.xnum ? ` <small title="X-Number header">→ ${esc(d.xnum)}</small>` : ''}</td>
      <td class="mono" style="font-size:12px">${esc(d.src)}<small> ${esc(epName(d.src))}</small></td><td class="mono" style="font-size:12px">${esc(d.dst)}<small> ${esc(epName(d.dst))}</small></td>
      <td class="r num">${d.count}</td><td><span class="chip ${STATE_CLS[d.state] || ''}">${esc(d.state)}${d.code && d.state === 'REJECTED' ? ' ' + d.code : ''}</span></td>
      <td class="mono" style="font-size:12px">${esc([...new Set(d.sdp.flatMap((s) => s.codecs))].join(' '))}</td></tr>`).join('')
      : `<tr><td colspan="9" class="empty">${r.status.running ? 'Waiting for SIP calls…' : 'Start a trace, then place or wait for a call.'}</td></tr>`;
    $$('#stBody tr[data-id]').forEach((tr) => (tr.onclick = () => { sel = tr.dataset.id; $$('#stBody tr').forEach((x) => x.classList.toggle('sel', x === tr)); flow(sel); }));
  };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { status(await api('POST', '/api/diag/sip/start', { ...formData(f), keepNoise: f.keepNoise.checked })); toast('SIP trace started'); load(); }
    catch (er) { toast(er.message, true); }
  });
  $('#stStop').onclick = async () => { status(await api('POST', '/api/diag/sip/stop')); };
  $('#stClr').onclick = async () => { status(await api('POST', '/api/diag/sip/clear')); sel = null; $('#stFlow').innerHTML = ''; lmReset(); load(); };
  $('#stQ').oninput = () => load().catch(() => {}); $('#stM').onchange = () => load().catch(() => {});

  // ---- live messages: poll new messages every second and append (like sngrep raw / tcpdump -A)
  let after = 0, paused = false, rows = 0, hiddenTot = {};
  const TYPE_NAME = { call: 'call', register: 'REGISTER', options: 'OPTIONS', other: 'other' };
  // messages left out by the type checkboxes: say so, with a one-click "show"
  const showHidden = () => {
    const ks = Object.keys(hiddenTot).filter((k) => hiddenTot[k]);
    $('#lmHidden').classList.toggle('hidden', !ks.length);
    $('#lmHidden').innerHTML = ks.map((k) => `<span>${fmtInt(hiddenTot[k])} ${TYPE_NAME[k]} message${hiddenTot[k] > 1 ? 's' : ''} hidden${k === 'options' ? ' (keep-alive pings to trunks / customers)' : ''}</span>
      <button type="button" class="btn sm" data-show="${k}">Show ${TYPE_NAME[k]}</button>`).join('');
    $$('#lmHidden [data-show]').forEach((b) => (b.onclick = () => { $(`.lt[value=${b.dataset.show}]`, el).checked = true; lmReset(); live().catch(() => {}); }));
  };
  const list = $('#lmList');
  const types = () => $$('.lt', el).filter((c) => c.checked).map((c) => c.value).join(',');
  const cls = (m) => (m.request ? 'req' : m.code < 200 ? 'prov' : m.code < 300 ? 'ok' : 'bad');
  const row = (m) => {
    const d = document.createElement('div');
    d.className = `lm ${cls(m)}${$('#lmFull').checked ? ' open' : ''}`;
    d.innerHTML = `<div class="lmrow"><span class="t">${esc(clock(m.ts))}.${String(Math.floor(m.ts % 1000)).padStart(3, '0')}</span>
      <span class="ep">${esc(m.src)}<small> ${esc(epName(m.src))}</small> → ${esc(m.dst)}<small> ${esc(epName(m.dst))}</small></span>
      <span class="lab">${esc(m.label)}${m.sdp ? ' <small>SDP ' + esc(m.sdp) + '</small>' : ''}</span><span class="cs">${esc(m.cseq)}</span>
      <span class="ft">${esc(m.from)} → ${esc(m.to)}${m.xnum ? ' <small>X-Number ' + esc(m.xnum) + '</small>' : ''}</span><span class="cid" title="show this call's flow">${esc(m.callId)}</span></div>
      <pre class="raw">${esc(m.raw)}</pre>`;
    $('.lmrow', d).onclick = () => d.classList.toggle('open');
    $('.cid', d).onclick = (e) => { e.stopPropagation(); flow(m.callId); };
    return d;
  };
  const lmReset = () => { after = 0; rows = 0; hiddenTot = {}; showHidden(); list.innerHTML = '<div class="empty">Waiting for SIP messages…</div>'; };
  const live = async () => {
    if (paused) return;
    if (!types()) { rows = 0; list.innerHTML = '<div class="empty">Tick at least one message type.</div>'; return; }
    const r = await api('GET', '/api/diag/sip/messages?' + new URLSearchParams({ after, types: types(), q: $('#lmQ').value.trim() }));
    status(r.status);
    for (const [k, n] of Object.entries(r.hidden || {})) hiddenTot[k] = (hiddenTot[k] || 0) + n;
    showHidden();
    if (!r.messages.length) {
      const nh = Object.values(hiddenTot).reduce((a, b) => a + b, 0);
      if (!rows) list.innerHTML = `<div class="empty">${nh ? `Nothing to show with the ticked types — ${fmtInt(nh)} message(s) are hidden, see above.`
        : r.status.running ? 'Waiting for SIP messages… (a pjsip reload only sends OPTIONS to trunks/customers; REGISTER appears only for trunks with a username/password)'
          : 'Start a trace: every SIP request and response shows up here as it happens.'}</div>`;
      after = Math.max(after, r.status.lastId || 0);
      return;
    }
    if (!rows) list.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const m of r.messages) frag.append(row(m));
    list.append(frag); rows += r.messages.length;
    while (rows > 1500) { list.firstElementChild.remove(); rows--; }   // keep the page light
    after = Math.max(r.messages[r.messages.length - 1].id, r.status.lastId || 0);
    if ($('#lmScroll').checked) list.scrollTop = list.scrollHeight;
  };
  $$('.lt', el).forEach((c) => (c.onchange = () => { lmReset(); live().catch(() => {}); }));
  let qt; $('#lmQ').oninput = () => { clearTimeout(qt); qt = setTimeout(() => { lmReset(); live().catch(() => {}); }, 300); };
  $('#lmFull').onchange = () => $$('.lm', list).forEach((x) => x.classList.toggle('open', $('#lmFull').checked));
  $('#lmPause').onclick = () => { paused = !paused; $('#lmPause').textContent = paused ? 'Resume' : 'Pause'; $('#lmPause').classList.toggle('primary', paused); };
  $('#lmEmpty').onclick = () => { rows = 0; list.innerHTML = '<div class="empty">Cleared — new messages appear here.</div>'; };

  const view = (v) => {
    Diag.sipView = v;
    $$('#stView button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    $('#vLive').classList.toggle('hidden', v !== 'live'); $('#vCalls').classList.toggle('hidden', v !== 'calls');
  };
  $$('#stView button').forEach((b) => (b.onclick = () => view(b.dataset.v)));
  if (Diag.sipPreset) {   // opened from Registrations: only REGISTER, live view
    $$('.lt', el).forEach((c) => (c.checked = Diag.sipPreset.types.includes(c.value)));
    Diag.sipView = 'live'; Diag.sipPreset = null;
  }
  view(Diag.sipView || 'live');
  await Promise.all([load(), live()]);
  diagPoll(() => (Diag.sipView === 'calls' ? load() : live()), 1000);
};

// call flow ladder for one dialog
async function flow(id) {
  const box = $('#stFlow');
  let g; try { g = await api('GET', '/api/diag/sip/dialog?id=' + encodeURIComponent(id)); } catch (e) { box.innerHTML = `<div class="panel"><div class="body">${esc(e.message)}</div></div>`; return; }
  const eps = []; for (const m of g.msgs) for (const x of [m.src, m.dst]) if (!eps.includes(x)) eps.push(x);
  // fixed pixel size (scrolls sideways when there are many hosts) so text never scales up or down
  const left = 90, rowH = 30, top = 52, colW = Math.max(230, Math.floor(700 / Math.max(1, eps.length - 1)));
  const W = left + colW * Math.max(1, eps.length - 1) + 140, H = top + rowH * g.msgs.length + 20;
  const X = (ep) => left + 60 + eps.indexOf(ep) * colW;
  const t0 = g.msgs.length ? g.msgs[0].ts : 0;
  const col = (m) => (m.request ? 'var(--ink)' : m.code < 200 ? 'var(--info)' : m.code < 300 ? 'var(--accent)' : 'var(--bad)');
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block;font-family:var(--mono)" role="img" aria-label="SIP call flow">`;
  eps.forEach((ep) => {
    s += `<text x="${X(ep)}" y="16" text-anchor="middle" font-size="11.5" font-weight="600" fill="var(--ink)">${esc(ep)}</text>` +
      `<text x="${X(ep)}" y="31" text-anchor="middle" font-size="10.5" fill="var(--ink-3)">${esc(epName(ep))}</text>` +
      `<line x1="${X(ep)}" x2="${X(ep)}" y1="${top - 12}" y2="${H - 6}" stroke="var(--line-2)" stroke-dasharray="3 3"/>`;
  });
  g.msgs.forEach((m, i) => {
    const y = top + i * rowH + 14, x1 = X(m.src), x2 = X(m.dst), dir = x2 >= x1 ? 1 : -1, c = col(m);
    s += `<g class="arrow" data-i="${i}" style="cursor:pointer"><rect x="0" y="${y - 20}" width="${W}" height="${rowH}" fill="transparent"/>` +
      `<text x="6" y="${y + 4}" font-size="10.5" fill="var(--ink-3)">+${((m.ts - t0) / 1000).toFixed(3)}s</text>` +
      `<line x1="${x1}" x2="${x2 - dir * 6}" y1="${y}" y2="${y}" stroke="${c}" stroke-width="1.6"/>` +
      `<path d="M${x2} ${y} l${-dir * 8} -4 v8 z" fill="${c}"/>` +
      `<text x="${(x1 + x2) / 2}" y="${y - 5}" text-anchor="middle" font-size="11.5" font-weight="600" fill="${c}">${esc(m.label)}${m.sdp ? ' (SDP)' : ''}</text></g>`;
  });
  s += '</svg>';
  box.innerHTML = `<div class="panel"><h2>Call flow · ${esc(g.callId)} <span><a class="btn sm" href="/api/diag/sip/dialog.pcap?id=${encodeURIComponent(g.callId)}">Download .pcap</a></span></h2>
    <div class="body"><div class="summary" style="padding:0 0 10px">
      <span class="chip ${STATE_CLS[g.state] || ''}">${esc(g.state)}${g.code ? ' ' + g.code + ' ' + esc(g.reason || '') : ''}</span>
      ${g.ua ? `<span class="chip">UA ${esc(g.ua)}</span>` : ''}${g.xdid ? `<span class="chip">X-DID ${esc(g.xdid)}</span>` : ''}${g.xnum ? `<span class="chip">X-Number ${esc(g.xnum)}</span>` : ''}
      ${g.ringAt ? `<span class="chip">ring after ${((g.ringAt - g.start) / 1000).toFixed(2)}s</span>` : ''}${g.answerAt ? `<span class="chip ok">answer after ${((g.answerAt - g.start) / 1000).toFixed(2)}s</span>` : ''}
      ${g.msgs.filter((m) => m.sdp).map((m) => `<span class="chip" title="SDP from ${esc(m.src)}">media ${esc(m.sdp.ip)}:${m.sdp.port} ${esc(m.sdp.codecs.slice(0, 3).join('/'))}${m.sdp.dir !== 'sendrecv' ? ' ' + esc(m.sdp.dir) : ''}</span>`).join('')}
    </div><div class="tw ladder">${s}</div><pre class="code" id="stRaw" style="margin-top:10px">Click an arrow to see the full SIP message.</pre></div></div>`;
  $$('#stFlow .arrow').forEach((a) => (a.onclick = () => {
    const m = g.msgs[+a.dataset.i];
    $$('#stFlow .arrow').forEach((x) => x.classList.toggle('on', x === a));
    $('#stRaw').textContent = `${fmtTime(m.ts)}  ${m.proto.toUpperCase()}  ${m.src} → ${m.dst}\n\n${m.raw}`;
  }));
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- RTP
DiagTab.rtp = async (el) => {
  el.innerHTML = `<div class="panel" style="margin-bottom:14px"><h2>Live channels — Asterisk RTP counters <span><label class="check" style="display:inline-flex;font-size:12.5px;text-transform:none;letter-spacing:0"><input type="checkbox" id="rAuto" checked> auto-refresh</label> <button class="btn sm" id="rRef">Refresh</button></span></h2>
      <div class="tw" style="max-height:420px;overflow:auto"><table><thead><tr><th>Channel</th><th>State</th><th>Caller → number</th><th class="r">Up</th><th class="r">RX pkts</th><th class="r">RX lost</th><th class="r">RX jitter</th><th class="r">TX pkts</th><th class="r">TX lost</th><th class="r">RTT</th><th>Problems</th></tr></thead><tbody id="rBody"></tbody></table></div></div>
    <div class="panel"><h2>Capture & analyse RTP streams <small style="text-transform:none;letter-spacing:0;font-weight:400">like tshark -z rtp,streams</small></h2>
      <form class="filters" id="rcf"><label>Seconds<select name="seconds"><option>5</option><option selected>10</option><option>20</option><option>30</option><option>60</option></select></label>
        ${targetField()}
        <div class="actions"><button class="btn primary" id="rcGo">Capture</button></div></form>
      <div class="summary" id="rcSum"></div>
      <div class="tw"><table><thead><tr><th>Source</th><th>Destination</th><th>SSRC</th><th>Codec</th><th class="r">Packets</th><th class="r">Lost</th><th class="r">Seq err</th><th class="r">Max Δ</th><th class="r">Jitter</th><th class="r">Max jitter</th><th class="r">Dur.</th><th>Problems</th></tr></thead><tbody id="rcBody"><tr><td colspan="12" class="empty">Captures RTP on ports ${'…'} for the chosen time and reports loss, jitter and one-way audio per stream.</td></tr></tbody></table></div></div>`;
  const live = async () => {
    let rows;
    try { rows = await api('GET', '/api/diag/rtp/channels'); } catch (e) { $('#rBody').innerHTML = `<tr><td colspan="11" class="empty">${esc(e.message)}</td></tr>`; return; }
    $('#rBody').innerHTML = rows.length ? rows.map((c) => { const s = c.stats || {}; return `<tr>
      <td class="mono" style="font-size:12px">${esc(c.name)}</td><td>${esc(c.state)}</td><td class="mono" style="font-size:12.5px">${esc(c.caller || '')} → ${esc(c.exten || c.connected || '')}</td>
      <td class="r num">${fmtDur(c.age)}</td>
      ${c.stats ? `<td class="r num">${fmtInt(s.rxcount)}</td><td class="r num">${fmtInt(s.rxploss)}</td><td class="r num">${s.rxjitterMs} ms</td><td class="r num">${fmtInt(s.txcount)}</td><td class="r num">${fmtInt(s.txploss)}</td><td class="r num">${s.rttMs ? s.rttMs + ' ms' : '—'}</td>`
        : `<td colspan="6" class="empty" style="padding:6px">no RTP on this channel (yet)</td>`}
      <td>${c.problems.map((p) => `<span class="chip bad">${esc(p)}</span>`).join(' ') || (c.stats ? '<span class="chip ok">OK</span>' : '')}</td></tr>`; }).join('')
      : `<tr><td colspan="11" class="empty">No active SIP channels.</td></tr>`;
  };
  $('#rRef').onclick = () => live();
  targetWire($('#rcf'));
  $('#rcf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target); const btn = $('#rcGo'); btn.disabled = true;
    $('#rcSum').innerHTML = `<span class="chip info">capturing for ${d.seconds}s…</span>`;
    try {
      const r = await api('POST', '/api/diag/rtp/capture', d);
      const bad = r.streams.filter((x) => x.problems.length).length;
      $('#rcSum').innerHTML = `<span class="chip">${fmtInt(r.packets)} packets</span><span class="chip">${r.streams.length} streams</span><span class="chip ${bad ? 'bad' : 'ok'}">${bad} with problems</span><span class="chip mono">${esc(r.filter)}</span>`;
      $('#rcBody').innerHTML = r.streams.length ? r.streams.map((x) => `<tr>
        <td class="mono" style="font-size:12px">${esc(x.src)}<small> ${esc(epName(x.src))}</small></td><td class="mono" style="font-size:12px">${esc(x.dst)}<small> ${esc(epName(x.dst))}</small></td>
        <td class="mono" style="font-size:12px">${esc(x.ssrc)}</td><td>${esc(x.codec)}</td><td class="r num">${fmtInt(x.packets)}</td>
        <td class="r num">${fmtInt(x.lost)} (${x.lossPct}%)</td><td class="r num">${x.seqErrors}</td><td class="r num">${x.maxDeltaMs} ms</td>
        <td class="r num">${x.jitterMs} ms</td><td class="r num">${x.maxJitterMs} ms</td><td class="r num">${x.durationSec}s</td>
        <td>${x.problems.map((p) => `<span class="chip bad">${esc(p)}</span>`).join(' ') || '<span class="chip ok">OK</span>'}</td></tr>`).join('')
        : `<tr><td colspan="12" class="empty">No RTP seen — no calls up, or media does not pass this server.</td></tr>`;
    } catch (er) { $('#rcSum').innerHTML = `<span class="chip bad" style="white-space:normal">${esc(er.message)}</span>`; }
    finally { btn.disabled = false; }
  });
  const st = await api('GET', '/api/diag/status').catch(() => null);
  if (st) $('#rcBody td.empty').textContent = `Captures RTP on UDP ${st.rtpRange.start}-${st.rtpRange.end} for the chosen time and reports loss, jitter and one-way audio per stream.`;
  await live(); diagPoll(() => ($('#rAuto').checked ? live() : Promise.resolve()), 5000);
};

// ---------------------------------------------------------------- tcpdump
DiagTab.pcap = async (el) => {
  const st = await api('GET', '/api/diag/status');
  const tool = (n, p) => `<span class="chip ${p ? 'ok' : ''}">${n} ${p ? esc(p) : 'not installed'}</span>`;
  const cmds = [
    ['Live SIP ladder in the terminal (sngrep)', `sngrep -d any port ${st.sipPort}`],
    ...(Diag.trunks || []).map((t) => [`sngrep: only trunk ${t.name}`, `sngrep -d any host ${t.host} and port ${st.sipPort}`]),
    ['sngrep: only calls with a number', `sngrep -d any -c 9876543210 port ${st.sipPort}`],
    ['SIP + RTP to a file (tcpdump)', `tcpdump -i any -nn -s0 -w /tmp/sip.pcap port ${st.sipPort} or udp portrange ${st.rtpRange.start}-${st.rtpRange.end}`],
    ['SIP messages as text (tcpdump)', `tcpdump -i any -nn -s0 -A port ${st.sipPort}`],
    ['RTP stream stats from a file (tshark)', 'tshark -r /tmp/sip.pcap -q -z rtp,streams'],
    ['SIP call list from a file (tshark)', 'tshark -r /tmp/sip.pcap -q -z sip,stat -z voip,calls'],
    ['Asterisk: SIP messages in the console', 'asterisk -rx "pjsip set logger on"   # off: pjsip set logger off'],
    ['Asterisk: RTP per channel', 'asterisk -rx "pjsip show channelstats"'],
  ];
  el.innerHTML = `<div class="grid two">
    <div class="panel"><h2>Download a capture</h2><form class="body" id="pf" style="display:flex;flex-direction:column;gap:10px">
      <div class="row" style="align-items:center"><span class="seg">
        <label class="check"><input type="radio" name="tool" value="tcpdump" checked> tcpdump <small>every packet</small></label>
        <label class="check"><input type="radio" name="tool" value="sngrep" ${st.tools.sngrep ? '' : 'disabled'}> sngrep <small>${st.tools.sngrep ? 'only SIP calls matching a number' : 'not installed'}</small></label></span></div>
      <div class="row">${targetField()}</div>
      <div class="row"><label>Seconds<select name="seconds"><option>10</option><option selected>30</option><option>60</option><option>120</option><option>300</option></select></label>
        <label class="sgOnly hidden">Match<input name="match" class="mono" placeholder="number, DID or Call-ID"></label>
        <label class="tdOnly">Extra port<input name="port" class="mono" placeholder="e.g. 5080" inputmode="numeric"></label></div>
      <div class="row" style="align-items:center"><label class="check"><input type="checkbox" name="sip" checked> SIP (port ${st.sipPort}/5060/5061)</label>
        <label class="check"><input type="checkbox" name="rtp"> RTP (UDP ${st.rtpRange.start}-${st.rtpRange.end})</label></div>
      <p class="hint">The download runs for the chosen time, then finishes. Open it in Wireshark: <b>Telephony → VoIP Calls</b> shows the call flow and lets you play the audio (needs RTP).</p>
      <div><button class="btn primary">Start capture & download</button></div></form></div>
    <div class="panel"><h2>Tools on this server</h2><div class="body"><div class="summary" style="padding:0 0 12px">${tool('tcpdump', st.tools.tcpdump)}${tool('tshark', st.tools.tshark)}${tool('sngrep', st.tools.sngrep)}</div>
      ${!st.tools.sngrep || !st.tools.tshark ? `<p class="hint">Optional for SSH use: <code>apt install sngrep tshark</code>. This page does not need them.</p>` : ''}
      <div class="cmds">${cmds.map(([t, c]) => `<div class="cmd"><div class="lab">${esc(t)}</div><div class="row" style="align-items:center"><code>${esc(c)}</code><button type="button" class="btn sm" data-copy="${esc(c)}">Copy</button></div></div>`).join('')}</div></div></div></div>`;
  $$('[data-copy]').forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
  const pf = $('#pf'); targetWire(pf);
  const toolSync = () => {
    const sg = pf.tool.value === 'sngrep';
    $$('.sgOnly', pf).forEach((x) => x.classList.toggle('hidden', !sg)); $$('.tdOnly', pf).forEach((x) => x.classList.toggle('hidden', sg));
  };
  $$('input[name=tool]', pf).forEach((r) => r.addEventListener('change', toolSync));
  pf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, d = formData(f);
    if (!f.sip.checked && !f.rtp.checked && !(d.tool === 'tcpdump' && d.port)) return toast('Tick SIP and/or RTP', true);
    // check the target first: a failed download would replace the page with an error
    try { if (d.target) await api('GET', '/api/diag/target?' + new URLSearchParams({ target: d.target, host: d.host || '' })); }
    catch (er) { return toast(er.message, true); }
    const qs = new URLSearchParams({ tool: d.tool, seconds: d.seconds, target: d.target || '', host: d.host || '', port: d.tool === 'tcpdump' ? d.port || '' : '',
      match: d.tool === 'sngrep' ? d.match || '' : '', sip: f.sip.checked ? '1' : '0', rtp: f.rtp.checked ? '1' : '0' });
    location.href = '/api/diag/pcap?' + qs;
    toast(`${d.tool} capturing for ${d.seconds}s — the file downloads when it finishes`);
  });
};

// ---------------------------------------------------------------- Asterisk log
const LOG_CLS = { ERROR: 'bad', WARNING: 'warn', NOTICE: 'info' };
DiagTab.log = async (el, preset = '') => {
  el.innerHTML = `<div class="panel"><form class="filters" id="lf">
      <label style="max-width:340px">Contains<input name="q" class="mono" placeholder="number, IP, C-0000001a, trunk name…" value="${esc(preset)}"></label>
      <label class="check" style="max-width:none"><input type="checkbox" name="ERROR" checked> ERROR</label>
      <label class="check" style="max-width:none"><input type="checkbox" name="WARNING" checked> WARNING</label>
      <label class="check" style="max-width:none"><input type="checkbox" name="NOTICE" checked> NOTICE</label>
      <label class="check" style="max-width:none"><input type="checkbox" name="VERBOSE" checked> VERBOSE</label>
      <label class="check" style="max-width:none"><input type="checkbox" name="DTMF"> DTMF</label>
      <label style="max-width:120px">Lines<select name="lines"><option>200</option><option selected>500</option><option>1000</option><option>2000</option></select></label>
      <label class="check" style="max-width:none" title="what asterisk -rvvv shows, refreshed every 3 s"><input type="checkbox" name="follow" ${preset ? '' : 'checked'}> Follow live (every 3 s)</label>
      <div class="actions"><button class="btn primary">Search</button></div></form>
    <div class="summary" id="lSum"></div><div class="body" style="padding-top:0"><pre class="code logbox" id="lOut">Loading…</pre></div></div>`;
  const f = $('#lf');
  let first = true;
  const load = async () => {
    const levels = ['ERROR', 'WARNING', 'NOTICE', 'VERBOSE', 'DTMF', 'DEBUG'].filter((l) => f[l] ? f[l].checked : false);
    const r = await api('GET', '/api/diag/log?' + new URLSearchParams({ q: f.q.value.trim(), lines: f.lines.value, levels: levels.join(',') }));
    const out = $('#lOut'); if (!out) return;
    const atEnd = first || out.scrollHeight - out.scrollTop - out.clientHeight < 40;   // stays put while you scroll up
    $('#lSum').innerHTML = `<span class="chip mono">${esc(r.file)}</span><span class="chip">${fmtInt(r.lines.length)} lines</span><span class="chip">searched last ${fmtInt(Math.round(r.scannedBytes / 1024))} KB</span>`;
    $('#lOut').innerHTML = r.lines.length ? r.lines.map((l) => {
      const lv = (/\]\s+([A-Z]+)\[/.exec(l) || [])[1];
      return `<span class="${LOG_CLS[lv] || ''}">${esc(l).replace(/\[(C-[0-9a-f]{8})\]/g, '[<a href="#" data-cid="$1">$1</a>]')}</span>`;
    }).join('\n') : 'No matching lines.';
    if (atEnd) out.scrollTop = out.scrollHeight;
    first = false;
    $$('#lOut [data-cid]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); f.q.value = a.dataset.cid; f.VERBOSE.checked = true; f.follow.checked = false; first = true; load().catch((er) => toast(er.message, true)); }));
  };
  const reload = () => { first = true; load().catch((er) => toast(er.message, true)); };
  f.addEventListener('submit', (e) => { e.preventDefault(); reload(); });
  f.q.addEventListener('input', () => { clearTimeout(Diag.logQ); if (f.follow.checked) Diag.logQ = setTimeout(reload, 400); });
  f.addEventListener('change', (e) => { if (e.target !== f.q) reload(); });
  diagPoll(() => (f.follow.checked ? load() : Promise.resolve()), 3000);
  await load();
};

// ---------------------------------------------------------------- call lookup
DiagTab.lookup = async (el) => {
  el.innerHTML = `<div class="panel" style="margin-bottom:14px"><form class="filters" id="cl" style="border-bottom:0">
      <label style="max-width:300px">Number / DID / Call-ID<input name="q" class="mono" required placeholder="e.g. 9876543210"></label>
      <label>From<input type="date" name="from" value="${daysAgo(1)}"></label><label>To<input type="date" name="to" value="${dayStr()}"></label>
      <div class="actions"><button class="btn primary">Look up</button></div></form></div><div id="clOut"></div>`;
  $('#cl').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target), num = d.q.replace(/[^0-9]/g, '');
    $('#clOut').innerHTML = '<div class="panel"><div class="body">Searching…</div></div>';
    const [calls, sip, log] = await Promise.all([
      num.length >= 3 ? api('GET', '/api/reports/calls?' + new URLSearchParams({ from: d.from, to: d.to, number: num, size: 50 })).catch(() => null) : null,
      api('GET', '/api/diag/sip/dialogs?' + new URLSearchParams({ q: d.q })).catch(() => null),
      api('GET', '/api/diag/log?' + new URLSearchParams({ q: num.length >= 3 ? num : d.q, lines: 200, levels: 'ERROR,WARNING,NOTICE,VERBOSE' })).catch(() => null),
    ]);
    const rows = calls ? calls.rows : [];
    $('#clOut').innerHTML = `<div class="panel" style="margin-bottom:14px"><h2>Calls (CDR) <span class="chip">${rows.length}${calls && calls.total > rows.length ? ' of ' + calls.total : ''}</span></h2>
      <div class="tw"><table><thead><tr><th>Start</th><th>Process → trunk</th><th>Number</th><th>Disposition</th><th>Why / what to check</th><th class="r">Ring</th><th class="r">Talk</th><th>Hangup cause</th></tr></thead><tbody>
      ${rows.length ? rows.map((c) => `<tr><td class="mono" style="font-size:12px;white-space:nowrap">${fmtTime(c.start_time)}</td>
        <td>${esc(c.process_code || '')} → ${esc(c.trunk_name || '')}${c.direction === 'in' ? ' <span class="chip info">in</span>' : ''}</td>
        <td class="mono">${esc(c.dialed || '')}${c.sent_number && c.sent_number !== c.dialed ? `<small> sent ${esc(c.sent_number)}</small>` : ''}</td>
        <td>${dispChip(c.disposition)}</td><td style="font-size:12.5px;color:var(--ink-2);max-width:360px">${esc(DISP_HELP[c.disposition] || '')}${c.hdr_status && !['ok', 'none'].includes(c.hdr_status) ? ` Header: ${esc(HDR_TXT[c.hdr_status] || c.hdr_status)} (X-DID "${esc(c.hdr_did || '')}", X-Number "${esc(c.hdr_num || '')}").` : ''}</td>
        <td class="r num">${c.ring_sec}s</td><td class="r num">${fmtDur(c.bill_sec)}</td>
        <td class="mono" style="font-size:12px">${c.hangup_cause ? `${c.hangup_cause} ${esc(Q850[c.hangup_cause] || '')}` : ''}${c.dialstatus ? ` · ${esc(c.dialstatus)}` : ''}</td></tr>`).join('')
        : `<tr><td colspan="8" class="empty">${num.length >= 3 ? 'No calls with this number in the date range.' : 'Enter at least 3 digits to search the CDR.'}</td></tr>`}</tbody></table></div></div>
      <div class="panel" style="margin-bottom:14px"><h2>SIP dialogs in the trace buffer <span class="chip">${sip ? sip.dialogs.length : 0}</span></h2><div class="body">
        ${sip && sip.dialogs.length ? sip.dialogs.slice(0, 30).map((g) => `<div class="cmd"><a href="#" data-flow="${esc(g.callId)}" class="mono">${esc(clock(g.start))} ${esc(g.method)} ${esc(g.from)} → ${esc(g.to)}</a> <span class="chip ${STATE_CLS[g.state] || ''}">${esc(g.state)}${g.code && g.state === 'REJECTED' ? ' ' + g.code : ''}</span></div>`).join('')
        : `<p class="hint">Nothing captured for this. Start a SIP trace on the <a href="#/diag?tab=sip">SIP trace</a> tab, then have the call placed again.</p>`}</div></div>
      <div class="panel"><h2>Asterisk log lines <span class="chip">${log ? log.lines.length : 0}</span></h2><div class="body"><pre class="code logbox">${log && log.lines.length ? log.lines.map((l) => esc(l)).join('\n') : 'No matching log lines.'}</pre></div></div>`;
    $$('#clOut [data-flow]').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); Diag.tab = 'sip'; location.hash = '#/diag?tab=sip'; setTimeout(() => flow(a.dataset.flow), 400); }));
  });
};

// =================================================================== ALERTS
const ROUTE_LABEL = { both: 'Slack + email', slack: 'Slack only', email: 'Email only', off: 'Off' };
PAGES.alerts = async (main) => {
  main.innerHTML = `<div class="head"><div><h1>Alerts</h1><p>Slack notifications when the health checks (<a href="#/diag?tab=issues">Diagnostics → Issues</a>, every 30 s) open, resolve or keep failing.</p></div></div>
    <div class="panel" style="margin-bottom:14px"><h2>Status</h2><div class="body"><div class="health" id="alStatus">Loading…</div></div></div>
    <div class="panel" style="margin-bottom:14px"><h2>Slack</h2><form class="body" id="alSlack" style="max-width:860px"></form></div>
    <div class="panel" style="margin-bottom:14px"><h2>Alert rules <span><button class="btn sm primary" id="alRulesSave">Save rules</button></span></h2><div class="body" id="alRules"></div></div>
    <div class="panel"><h2>Recently sent</h2><div class="tw" style="max-height:340px;overflow:auto"><table><thead><tr><th>When</th><th>Channel</th><th>Type</th><th>Message</th><th>Result</th></tr></thead><tbody id="alLog"></tbody></table></div></div>`;

  const save = async (body, what) => { const a = await api('PUT', '/api/diag/alerts', body); toast(`${what} saved`); draw(a); return a; };
  const sendTest = async (ch, btn) => {
    btn.disabled = true;
    try { await api('POST', '/api/diag/alerts/test', { channel: ch }); toast('Test alert sent — check the Slack channel'); }
    catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; draw(await api('GET', '/api/diag/alerts')); }
  };
  const fromUi = (a, k, set) => (set && a.source[k] !== 'ui' ? ' <small class="hint">(from .env)</small>' : '');

  const draw = (a) => {
    const on = (x) => `<span class="chip ${x ? 'ok' : ''}">${x ? 'ON' : 'NOT SET UP'}</span>`;
    const n = a.types.filter((t) => t.route !== 'off').length;
    $('#alStatus').innerHTML = `
      <div class="hbox"><div class="lab">Slack</div><div class="v">${on(a.slack.configured)}${a.slack.invalid ? ' <span class="chip bad">invalid URL</span>' : ''}</div></div>
      ${a.email.configured ? `<div class="hbox"><div class="lab">Email</div><div class="v"><span class="chip ok">ON</span> <small>${esc(a.email.to.length)} recipient(s), from .env</small></div></div>` : ''}
      <div class="hbox"><div class="lab">Alert types on</div><div class="v">${n} of ${a.types.length}</div></div>
      <div class="hbox"><div class="lab">Reminders</div><div class="v" style="font-weight:400;font-size:12.5px">${a.rules.remindMin ? `every ${a.rules.remindMin} min while critical` : 'off'} · ${a.rules.resolved ? 'resolved messages on' : 'no resolved messages'}</div></div>`;

    // ---- Slack
    $('#alSlack').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div>${on(a.slack.configured)}${fromUi(a, 'slack', a.slack.configured)}</div>
        <label>Incoming webhook URL<input name="webhook" class="mono" autocomplete="off" spellcheck="false"
          placeholder="${a.slack.configured ? 'saved — leave blank to keep, or paste a new URL' : 'https://hooks.slack.com/services/T…/B…/…'}">
          <small>Kept on the server only. This page never shows it again.</small></label>
        <label class="check"><input type="checkbox" name="mention" ${a.slack.mention ? 'checked' : ''}> Mention <code>@channel</code> on critical alerts and reminders</label>
        <div class="row" style="justify-content:flex-start;gap:8px"><button class="btn primary">Save</button>
          <button type="button" class="btn" data-t ${a.slack.configured ? '' : 'disabled'}>Send test</button>
          ${a.slack.configured && a.source.slack === 'ui' ? '<button type="button" class="btn danger" data-clear>Remove</button>' : ''}</div>
      </div>
      <details class="setup" style="margin-top:14px" ${a.slack.configured ? '' : 'open'}><summary>How to connect Slack (5 minutes)</summary>
        <ol class="steps">
          <li>Open <a href="https://api.slack.com/apps" target="_blank" rel="noopener">api.slack.com/apps</a> while signed in to your Slack workspace and click <b>Create New App → From scratch</b>.
            Name it e.g. <i>SIPDist alerts</i> and pick the workspace.</li>
          <li>In the app's left menu open <b>Features → Incoming Webhooks</b> and switch <b>Activate Incoming Webhooks</b> on.</li>
          <li>Click <b>Add New Webhook to Workspace</b> (bottom of the page), choose the channel for alerts (e.g. <code>#noc-alerts</code>) and click <b>Allow</b>.
            For a private channel you must be a member of it first. If your workspace needs admin approval, ask a Slack admin to approve the app.</li>
          <li>Copy the new <b>Webhook URL</b>. It looks like <code>https://hooks.slack.com/services/T0…/B0…/xxxxxxxx</code>.</li>
          <li>Paste it in the box above, click <b>Save</b>, then <b>Send test</b>. A ✅ test message should show up in the channel within a few seconds.</li>
        </ol>
        <p class="hint"><b>Each webhook posts to one channel.</b> To send alerts to a different channel, add another webhook in the same Slack app and paste the new URL here.
          Anyone with the URL can post to the channel, so treat it like a password. If it leaks, delete it in Slack (Incoming Webhooks → Remove) and save a new one.</p>
        <p class="hint" style="margin-top:6px"><b>If the test fails:</b> <code>404 no_service</code> / <code>410</code> means the webhook was removed or the app uninstalled, so create a new one.
          <code>403 invalid_token</code> means the URL was copied wrong. <code>404 channel_not_found</code> means the channel was archived or deleted.
          A timeout means this server cannot reach <code>hooks.slack.com:443</code>. Allow outbound HTTPS in the firewall.</p>
        <p class="hint" style="margin-top:6px">Alternative: set <code>ALERT_SLACK_WEBHOOK=…</code> in <code>/opt/sipdist/.env</code> and restart <code>sipdist</code>. A URL saved on this page takes priority over <code>.env</code>.</p>
      </details>`;
    const fs = $('#alSlack');
    fs.onsubmit = async (e) => { e.preventDefault(); try { await save({ slack: { webhook: fs.webhook.value.trim(), mention: fs.mention.checked } }, 'Slack settings'); } catch (err) { toast(err.message, true); } };
    $('[data-t]', fs).onclick = (e) => sendTest('slack', e.currentTarget);
    if ($('[data-clear]', fs)) $('[data-clear]', fs).onclick = async () => { if (await confirmBox('Remove Slack webhook', 'Slack alerts stop until a new webhook URL is saved.', 'Remove')) save({ clear: ['slack'] }, 'Slack webhook removed').catch((e) => toast(e.message, true)); };

    // ---- Rules: the Gmail panel is hidden, so the email choices only show when email is set up in .env
    const em = a.email.configured;
    const shown = (r) => (em ? r : r === 'both' ? 'slack' : r === 'email' ? 'off' : r);
    const labels = em ? ROUTE_LABEL : { slack: 'Slack', off: 'Off' };
    $('#alRules').innerHTML = `
      <div class="fgrid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-bottom:14px">
        <label>Reminder for critical issues still open <small>minutes, 0 = off</small><input name="remindMin" type="number" min="0" max="1440" value="${a.rules.remindMin}"></label>
        <label>Server name in messages<input name="name" value="${esc(a.name)}" maxlength="60"></label>
        <label class="check" style="align-self:end"><input type="checkbox" name="resolved" ${a.rules.resolved ? 'checked' : ''}> Send a message when an issue is resolved</label>
      </div>
      <p class="hint" style="margin-bottom:8px">${em ? 'Choose where each alert goes. Alerts from the same check run are grouped into one message per channel.' : 'Turn each alert type on or off. Alerts from the same check run are grouped into one Slack message.'}</p>
      <div class="tw"><table><thead><tr><th>Severity</th><th>Alert</th><th>When</th><th style="width:170px">Send to</th></tr></thead><tbody>
        ${a.types.map((t) => `<tr><td><span class="chip ${t.severity === 'critical' ? 'bad' : 'warn'}">${t.severity}</span></td><td><b>${esc(t.label)}</b></td>
          <td style="font-size:12.5px;color:var(--ink-2)">${esc(t.about)}</td>
          <td><select data-type="${t.type}" data-route="${t.route}">${Object.entries(labels).map(([k, l]) => `<option value="${k}" ${shown(t.route) === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td></tr>`).join('')}
      </tbody></table></div>`;
    $('#alRulesSave').onclick = async () => {
      const r = $('#alRules'), routes = {};
      // unchanged rows keep their saved route (e.g. 'both' shown as 'Slack' while email is not set up)
      $$('select[data-type]', r).forEach((x) => (routes[x.dataset.type] = x.value === shown(x.dataset.route) ? x.dataset.route : x.value));
      try { await save({ rules: { remindMin: $('[name=remindMin]', r).value, name: $('[name=name]', r).value, resolved: $('[name=resolved]', r).checked, routes } }, 'Alert rules'); }
      catch (e) { toast(e.message, true); }
    };

    $('#alLog').innerHTML = a.recent.length ? a.recent.map((r) => `<tr><td class="mono" style="font-size:12px;white-space:nowrap">${fmtTime(r.at)}</td><td>${esc(r.channel)}</td><td>${esc(r.kind)}</td>
      <td style="font-size:12.5px">${esc(r.subject || '')}</td><td>${r.ok ? '<span class="chip ok">sent</span>' : `<span class="chip bad" title="${esc(r.error || '')}">failed</span> <small>${esc((r.error || '').slice(0, 100))}</small>`}</td></tr>`).join('')
      : '<tr><td colspan="5" class="empty" style="padding:14px">Nothing sent yet.</td></tr>';
  };
  try { draw(await api('GET', '/api/diag/alerts')); } catch (e) { $('#alStatus').textContent = e.message; }
};

// =================================================================== USERS
const TAB_LABEL = { live: 'Live dashboard', cdr: 'CDR report', stats: 'Daily statistics' };
const ROLE_CHIP = { superadmin: '<span class="chip ok">Super admin</span>', admin: '<span class="chip info">Admin</span>', viewer: '<span class="chip">Monitor</span>' };
const ROLE_NAME = { superadmin: 'super admin', admin: 'admin', viewer: 'monitor' };
const uaShort = (ua) => {
  ua = ua || '';
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl/i.test(ua) ? 'curl' : ua ? 'Other' : '—';
  const o = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return o ? `${b} · ${o}` : b;
};
PAGES.users = async (main) => {
  main.innerHTML = `<div class="head"><div><h1>Users</h1><p><b>Super admins</b> have full access including the Activity log. <b>Admins</b> have full access except the Activity log and cannot change super admins. <b>Monitor</b> users (e.g. team leaders) are read-only and see only the processes and tabs you pick. The server enforces this, not just the menu.</p></div>
      <div class="actions"><button class="btn primary" id="uAdd">+ Add user</button></div></div>
    <div class="panel" style="margin-bottom:14px"><div class="tw"><table><thead><tr><th>User</th><th>Role</th><th>Processes</th><th>Tabs</th><th>Status</th><th>Last sign-in</th><th class="r">Sessions</th><th></th></tr></thead><tbody id="uBody"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody></table></div></div>
    <div class="panel"><h2>Sessions <span style="display:flex;gap:8px;align-items:center"><label class="check" style="font-size:12.5px"><input type="checkbox" id="sAll"> show ended</label>
      <button class="btn sm" id="sEndAll">Sign out all other sessions</button></span></h2>
      <div class="body" style="padding-bottom:6px"><p class="hint" id="sNote"></p></div>
      <div class="tw" style="max-height:460px;overflow:auto"><table><thead><tr><th>User</th><th>IP</th><th>Browser</th><th>Signed in</th><th>Last activity</th><th>Expires / ended</th><th></th></tr></thead><tbody id="sBody"></tbody></table></div></div>`;
  let data = null;

  const loadUsers = async () => {
    data = await api('GET', '/api/users');
    const pname = Object.fromEntries(data.processes.map((p) => [p.code, p.name]));
    // a plain admin sees super admins read-only (the server refuses changes too)
    const may = (u) => data.super || u.role !== 'superadmin';
    $('#uBody').innerHTML = data.users.map((u) => `<tr>
      <td class="t-name"><b>${esc(u.username)}${u.username === data.me ? ' <span class="chip">you</span>' : ''}</b><small>${esc(u.full_name)}</small></td>
      <td>${ROLE_CHIP[u.role] || esc(u.role)}</td>
      <td style="font-size:12.5px">${u.role !== 'viewer' ? '<span class="hint">all</span>' : u.processes.map((c) => `<span class="chip" title="${esc(pname[c] || 'deleted process')}">${esc(c)}</span>`).join(' ') || '—'}</td>
      <td style="font-size:12.5px">${u.role !== 'viewer' ? '<span class="hint">all</span>' : u.tabs.map((t) => esc(TAB_LABEL[t] || t)).join(', ')}</td>
      <td>${u.active ? '<span class="chip ok">active</span>' : '<span class="chip bad">disabled</span>'}</td>
      <td class="mono" style="font-size:12px;white-space:nowrap">${u.last_login ? fmtTime(u.last_login) : '—'}</td>
      <td class="r num">${u.sessions}</td>
      <td class="r" style="white-space:nowrap">${!may(u) ? '<span class="hint">super admin only</span>' : `<button class="btn sm" data-edit="${u.id}">Edit</button> <button class="btn sm" data-pw="${u.id}">Password</button>
        ${u.sessions && u.username !== data.me ? `<button class="btn sm" data-out="${esc(u.username)}" title="End all sessions of this user">Sign out</button>` : ''}
        ${u.username !== data.me ? `<button class="btn sm danger" data-del="${u.id}">Delete</button>` : ''}`}</td></tr>`).join('');
    const byId = (id) => data.users.find((u) => u.id === +id);
    $$('#uBody [data-edit]').forEach((b) => (b.onclick = () => userForm(byId(b.dataset.edit))));
    $$('#uBody [data-pw]').forEach((b) => (b.onclick = () => pwForm(byId(b.dataset.pw))));
    $$('#uBody [data-out]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmBox('Sign out user', `End every session of <b>${esc(b.dataset.out)}</b>? They must sign in again.`, 'Sign out'))) return;
      try { const r = await api('POST', '/api/users/sessions/end', { user: b.dataset.out }); toast(`${r.ended} session(s) ended`); refresh(); } catch (e) { toast(e.message, true); }
    }));
    $$('#uBody [data-del]').forEach((b) => (b.onclick = async () => {
      const u = byId(b.dataset.del);
      if (!(await confirmBox('Delete user', `Delete <b>${esc(u.username)}</b>? Their sessions end at once.`))) return;
      try { await api('DELETE', `/api/users/${u.id}`); toast('User deleted'); refresh(); } catch (e) { toast(e.message, true); }
    }));
  };

  const loadSessions = async () => {
    const r = await api('GET', '/api/users/sessions' + ($('#sAll').checked ? '?all=1' : ''));
    $('#sNote').textContent = `A session lasts ${r.ttlHours} h from sign-in. Signing a session out also closes its live feed at once. Disabling a user, changing their role or password signs them out everywhere.`;
    $('#sBody').innerHTML = r.sessions.length ? r.sessions.map((x) => `<tr style="${x.open ? '' : 'opacity:.55'}">
      <td class="t-name"><b>${esc(x.username)}${x.current ? ' <span class="chip ok">this session</span>' : ''}</b><small>${x.role ? ROLE_NAME[x.role] || esc(x.role) : 'deleted user'}${x.full_name ? ' · ' + esc(x.full_name) : ''}</small></td>
      <td class="mono" style="font-size:12.5px">${esc(x.ip || '')}</td><td style="font-size:12.5px" title="${esc(x.user_agent || '')}">${esc(uaShort(x.user_agent))}</td>
      <td class="mono" style="font-size:12px;white-space:nowrap">${fmtTime(x.created_at)}</td>
      <td class="mono" style="font-size:12px;white-space:nowrap" title="${fmtTime(x.last_seen)}">${ago(new Date(x.last_seen))} ago</td>
      <td class="mono" style="font-size:12px;white-space:nowrap">${x.open ? fmtTime(x.expires_at) : x.revoked_at ? `ended ${fmtTime(x.revoked_at)}${x.revoked_by && x.revoked_by !== x.username ? ` by ${esc(x.revoked_by)}` : ''}` : 'expired'}</td>
      <td class="r">${x.open && !x.current && (isSuper() || x.role !== 'superadmin') ? `<button class="btn sm" data-end="${x.id}">Sign out</button>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="7" class="empty">No sessions.</td></tr>';
    $$('#sBody [data-end]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try { await api('DELETE', `/api/users/sessions/${b.dataset.end}`); toast('Session signed out'); refresh(); } catch (e) { toast(e.message, true); b.disabled = false; }
    }));
  };
  const refresh = () => Promise.all([loadUsers(), loadSessions()]).catch((e) => toast(e.message, true));

  const userForm = (u) => {
    const v = u || { role: 'viewer', processes: [], tabs: ['live', 'cdr', 'stats'], active: true };
    openModal(u ? `Edit user ${u.username}` : 'Add user', `<form id="uf"><div class="fgrid" style="padding:16px 18px 0">
      ${u ? '' : `<label>Username<input name="username" required pattern="[a-zA-Z0-9._\\-]{3,64}" autocomplete="off" placeholder="e.g. tl_ravi"></label>`}
      <label>Full name <small>optional</small><input name="full_name" value="${esc(v.full_name || '')}" maxlength="100"></label>
      ${u ? '' : `<label class="full">Password <small>at least 8 characters</small><div class="row"><input name="password" required minlength="8" autocomplete="new-password" class="mono"><button type="button" class="btn" id="uGen">Generate</button></div></label>`}
      <label class="full">Role<select name="role" ${u && u.username === data.me ? 'disabled title="You cannot change your own role"' : ''}><option value="viewer" ${v.role === 'viewer' ? 'selected' : ''}>Monitor (team leader): read-only, chosen processes and tabs</option>
        <option value="admin" ${v.role === 'admin' ? 'selected' : ''}>Admin: full access except the Activity log</option>
        ${data.super ? `<option value="superadmin" ${v.role === 'superadmin' ? 'selected' : ''}>Super admin: full access and the Activity log</option>` : ''}</select></label>
      <div class="full vOnly"><div class="lab" style="font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:6px">Tabs this user can open</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap">${data.tabs.map((t) => `<label class="check"><input type="checkbox" name="tab" value="${t}" ${v.tabs.includes(t) ? 'checked' : ''}> ${TAB_LABEL[t] || t}</label>`).join('')}</div></div>
      <div class="full vOnly"><div class="lab" style="font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:6px;display:flex;justify-content:space-between">Processes this user can see
        <span><button type="button" class="link" id="pAll">all</button> · <button type="button" class="link" id="pNone">none</button></span></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px 14px;max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:10px">
        ${data.processes.length ? data.processes.map((p) => `<label class="check"><input type="checkbox" name="proc" value="${esc(p.code)}" ${v.processes.includes(p.code) ? 'checked' : ''}> <b>${esc(p.code)}</b> <small>${esc(p.name)}${p.active ? '' : ' · inactive'}</small></label>`).join('') : '<span class="hint">No processes yet.</span>'}</div>
        <p class="hint" style="margin-top:6px">Live counters, finished-call feed, CDR, CSV export and statistics are limited to these processes. Trunks, other processes and all settings stay hidden.</p></div>
      ${u ? `<label class="check full"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active (unticking signs the user out and blocks sign-in)</label>` : ''}
      </div><p class="err" id="uErr" style="padding:0 18px"></p>
      <div class="mfoot" style="padding:0 18px 16px"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${u ? 'Save' : 'Add user'}</button></div></form>`, (c) => {
      const f = $('#uf', c);
      const sync = () => $$('.vOnly', c).forEach((x) => x.classList.toggle('hidden', f.role.value !== 'viewer'));
      f.role.onchange = sync; sync();
      const gen = () => { const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = crypto.getRandomValues(new Uint32Array(12)); return [...r].map((x) => a[x % a.length]).join(''); };
      if ($('#uGen', c)) $('#uGen', c).onclick = () => { f.password.value = gen(); };
      $('#pAll', c).onclick = () => $$('input[name=proc]', c).forEach((x) => (x.checked = true));
      $('#pNone', c).onclick = () => $$('input[name=proc]', c).forEach((x) => (x.checked = false));
      f.onsubmit = async (e) => {
        e.preventDefault();
        const b = { full_name: f.full_name.value.trim(), role: f.role.value,
          processes: $$('input[name=proc]:checked', c).map((x) => x.value), tabs: $$('input[name=tab]:checked', c).map((x) => x.value) };
        if (!u) { b.username = f.username.value.trim(); b.password = f.password.value; } else b.active = f.active.checked;
        try {
          if (u) await api('PUT', `/api/users/${u.id}`, b); else await api('POST', '/api/users', b);
          closeModal();
          toast(u ? 'User saved' : `User ${b.username} added${b.role === 'viewer' ? ' — share the username and password with them' : ''}`);
          refresh();
        } catch (er) { $('#uErr', c).textContent = er.message; }
      };
    });
  };

  const pwForm = (u) => openModal(`New password · ${u.username}`, `<form class="mbody" id="upf" style="display:flex;flex-direction:column;gap:10px">
      <label>New password <small>at least 8 characters</small><input name="password" required minlength="8" autocomplete="new-password" class="mono"></label>
      <p class="hint">${u.username === data.me ? 'Your other sessions are signed out.' : `All sessions of ${esc(u.username)} are signed out.`}</p>
      <p class="err" id="upErr"></p><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Set password</button></div></form>`, (c) => {
    $('#upf', c).onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('POST', `/api/users/${u.id}/password`, formData(e.target)); closeModal(); toast(`Password set · ${r.sessionsEnded} session(s) signed out`); refresh(); }
      catch (er) { $('#upErr', c).textContent = er.message; }
    };
  });

  $('#uAdd').onclick = () => userForm(null);
  $('#sAll').onchange = () => loadSessions().catch((e) => toast(e.message, true));
  $('#sEndAll').onclick = async () => {
    if (!(await confirmBox('Sign out everyone else', 'End every session except this one? All other users must sign in again.', 'Sign out all'))) return;
    try { const r = await api('POST', '/api/users/sessions/end', {}); toast(`${r.ended} session(s) ended`); refresh(); } catch (e) { toast(e.message, true); }
  };
  await refresh();
};

// =================================================================== ACTIVITY (super admins)
// Requests: every action of every user (activity_log). Changes: what was saved, with the values (audit_log).
PAGES.activity = async (main) => {
  main.innerHTML = `<div class="head"><div><h1>Activity log</h1><p>What every user did: pages opened, searches, exports, changes, sign-ins and failed sign-ins. Only super admins see this page. Times in ${esc(S.tz)}. Old entries are removed by the retention job.</p></div></div>
    <div class="tabs big" id="aTabs"><button data-t="req" class="on">Activity</button><button data-t="chg">Changes (saved values)</button></div>
    <div class="panel"><form class="filters" id="af">
      <label>From<input type="date" name="from" value="${dayStr()}"></label>
      <label>To<input type="date" name="to" value="${dayStr()}"></label>
      <label>User<select name="user"><option value="">All users</option></select></label>
      <label>Search<input name="q" placeholder="action, page, IP…"></label>
      <label class="check reqOnly" style="align-self:center"><input type="checkbox" name="auth" value="1"> sign-in / sign-out only</label>
      <label class="check reqOnly" style="align-self:center"><input type="checkbox" name="writes" value="1"> changes only</label>
      <label class="check reqOnly" style="align-self:center"><input type="checkbox" name="failed" value="1"> refused / failed only</label>
      <div class="actions"><button class="btn primary">Search</button></div>
    </form><div class="summary" id="aSum"></div>
    <div class="tw"><table><thead id="aHead"></thead><tbody id="aBody"></tbody></table></div>
    <div class="pager" id="aPager"></div></div>`;
  const f = $('#af'); let page = 1, tab = 'req', usersLoaded = false;
  const qs = () => { const d = formData(f); for (const k of ['auth', 'writes', 'failed']) if (!f[k].checked) delete d[k]; return new URLSearchParams({ ...d, page }).toString(); };
  const td = (v, st = '') => `<td style="${st}">${v}</td>`;
  const when = (r) => `<td class="mono" style="font-size:12px;white-space:nowrap" title="${fmtTime(r.at)}">${fmtShort(r.at)}</td>`;
  const load = async () => {
    $$('#aTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
    $$('.reqOnly', f).forEach((x) => x.classList.toggle('hidden', tab !== 'req'));
    const cols = tab === 'req' ? 5 : 4;
    $('#aHead').innerHTML = tab === 'req'
      ? '<tr><th>When</th><th>User</th><th>Action</th><th>What was viewed / changed</th><th>IP</th></tr>'
      : '<tr><th>When</th><th>User</th><th>Change</th><th>What was changed</th></tr>';
    $('#aBody').innerHTML = `<tr><td colspan="${cols}" class="empty">Loading…</td></tr>`;
    try {
      const r = await api('GET', `/api/activity${tab === 'chg' ? '/changes' : ''}?` + qs());
      if (r.users && !usersLoaded) {
        usersLoaded = true;
        f.user.insertAdjacentHTML('beforeend', r.users.map((u) => `<option>${esc(u)}</option>`).join(''));
      }
      $('#aSum').innerHTML = `<span class="chip">${fmtInt(r.total)} entries</span><span class="chip">${esc(r.from)}${r.from !== r.to ? ' → ' + esc(r.to) : ''}</span>`;
      $('#aBody').innerHTML = !r.rows.length ? `<tr><td colspan="${cols}" class="empty">Nothing for this filter.</td></tr>`
        : tab === 'req' ? r.rows.map((x) => `<tr>${when(x)}
            <td class="t-name"><b>${esc(x.username || '?')}</b><small>${esc(ROLE_NAME[x.role] || x.role || '')}</small></td>
            ${td(esc(x.action || `${x.method} ${x.path}`))}
            <td style="font-size:12.5px;max-width:560px;overflow-wrap:anywhere${x.status >= 400 ? ';color:var(--bad)' : ''}">${esc(x.detail || '')}</td>
            <td class="mono" style="font-size:12px">${esc(x.ip || '')}</td></tr>`).join('')
        : r.rows.map((x) => `<tr>${when(x)}${td(`<b>${esc(x.admin || '?')}</b>`)}${td(esc(x.action))}
            <td style="font-size:12.5px;max-width:620px;overflow-wrap:anywhere">${esc(x.detail || '')}</td></tr>`).join('');
      const pages = Math.max(1, Math.ceil(r.total / r.size));
      $('#aPager').innerHTML = `Page ${page} of ${pages} <button class="btn sm" id="apv" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button><button class="btn sm" id="anx" ${page >= pages ? 'disabled' : ''}>Next ›</button>`;
      $('#apv').onclick = () => { page--; load(); }; $('#anx').onclick = () => { page++; load(); };
    } catch (e) { $('#aBody').innerHTML = `<tr><td colspan="${cols}" class="empty">${esc(e.message)}</td></tr>`; }
  };
  $$('#aTabs button').forEach((b) => (b.onclick = () => { tab = b.dataset.t; page = 1; load(); }));
  f.addEventListener('submit', (e) => { e.preventDefault(); page = 1; load(); });
  load();
};

// =================================================================== SYSTEM
PAGES.system = async (main) => {
  main.innerHTML = `<div class="head"><div><h1>System</h1><p>Server resources, health, generated Asterisk config and Asterisk views. Live Asterisk CLI log: <a href="#/diag?tab=log">Diagnostics → Asterisk log</a>.</p></div>
    <div class="actions"><button class="btn" id="reapply">Re-apply config to Asterisk</button></div></div>
    <div class="panel" style="margin-bottom:14px"><h2>Server resources <small id="resInfo" style="font-weight:400;color:var(--ink-3);font-size:12.5px"></small></h2><div class="body"><div class="grid kpis" id="res" style="margin-bottom:0">Loading…</div></div></div>
    <div class="panel" style="margin-bottom:14px"><h2>Health</h2><div class="body"><div class="health" id="health">Loading…</div></div></div>
    <div class="panel" style="margin-bottom:14px"><h2>Where the UI meets Asterisk</h2><div class="body"><div class="tw"><table>
      <thead><tr><th>UI action</th><th>Backend</th><th>Asterisk</th></tr></thead><tbody>
      <tr><td>Add / edit / (de)activate trunk</td><td><code>trunks</code> table → <code>render.js</code></td><td><code>/etc/asterisk/sipdist/trunks.conf</code> → ARI <code>PUT /asterisk/modules/res_pjsip.so</code></td></tr>
      <tr><td>Add / edit process, change limit</td><td><code>processes</code> table</td><td><code>processes.conf</code> (endpoint/auth/identify) + <code>dialplan.conf</code> (<code>proc-&lt;code&gt;</code>, GROUP_COUNT limit) → reload res_pjsip + pbx_config</td></tr>
      <tr><td>Live dashboard</td><td>ARI events WS → Redis counters → <code>/ws</code></td><td><code>ChannelCreated</code> / <code>ChannelDestroyed</code>, reconciled from <code>GET /ari/channels</code> every 10 s</td></tr>
      <tr><td>CDR & daily stats</td><td><code>calls</code> + <code>daily_stats</code></td><td>hangup handler <code>sd-hangup</code> → <code>UserEvent(SIPDIST_END)</code>; backup in <code>cdr</code> via cdr_pgsql</td></tr>
      </tbody></table></div></div></div>
    <div class="grid two" style="margin-bottom:14px">
      <div class="panel"><h2>Generated config</h2><div class="body"><div class="tabs" id="cfgTabs"></div><pre class="code" id="cfgCode">Loading…</pre></div></div>
      <div class="panel"><h2>Asterisk CLI (read-only)</h2><div class="body"><div class="tabs" id="cliTabs">
        ${['endpoints', 'registrations', 'contacts', 'groups', 'channels', 'channelstats', 'transports', 'qualify', 'rtp'].map((x, i) => `<button data-cli="${x}" class="${i ? '' : 'on'}">${x}</button>`).join('')}</div><pre class="code" id="cliOut">…</pre></div></div>
    </div>
    <div class="grid two">
      <div class="panel"><h2>Change password</h2><form class="body" id="pwf" style="display:flex;flex-direction:column;gap:10px;max-width:360px">
        <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
        <label>New password<input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
        <p class="err" id="pwErr"></p><div><button class="btn primary">Change password</button></div></form></div>
    </div>`;
  const health = async () => {
    const h = await api('GET', '/api/system/health');
    const box = (lab, ok, v) => `<div class="hbox"><div class="lab">${lab}</div><div class="v"><span class="chip ${ok ? 'ok' : 'bad'}">${ok ? 'OK' : 'DOWN'}</span> ${esc(v || '')}</div></div>`;
    const a = h.apply || {};
    $('#health').innerHTML = box('Asterisk', h.asterisk && !h.asterisk.error, h.asterisk && (h.asterisk.version || h.asterisk.error)) +
      box('ARI events', h.ari, h.ari ? 'subscribed' : 'reconnecting') + box('PostgreSQL', h.db, h.dbError) + box('Redis', h.redis, h.redisError) +
      `<div class="hbox"><div class="lab">Last config apply</div><div class="v"><span class="chip ${a.ok ? 'ok' : a.ok === false ? 'bad' : ''}">${a.ok ? 'OK' : a.ok === false ? 'FAILED' : '—'}</span> <span style="font-weight:400;font-size:12.5px">${a.at ? fmtTime(a.at) : ''} ${esc(a.error || '')}</span></div></div>`;
  };
  // CPU / RAM / storage tiles; meter turns amber at 80 %, red at 95 %
  const gb = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(2)} TB` : `${(b / 1e9).toFixed(1)} GB`);
  const pct = (u, t) => (t ? Math.round((u / t) * 1000) / 10 : 0);
  const GRAPH_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.5 13.5h13M3 10.5l3-3.5 2.5 2 4.5-5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const tile = (lab, p, sub, key, title) => `<div class="kpi hbox"><div class="lab">${lab}<button class="rh-btn" data-graph="${esc(key)}" data-title="${esc(title)}" title="History — last 5 days" aria-label="${esc(title)} history">${GRAPH_ICON}</button></div><div class="val">${p}<small>%</small></div>${meter(p, 100)}<div class="sub">${sub}</div></div>`;
  const resources = async () => {
    const r = await api('GET', '/api/system/resources');
    const c = r.cpu, m = r.memory, d = Math.floor(r.uptime / 86400), h = Math.floor((r.uptime % 86400) / 3600);
    $('#resInfo').textContent = `· ${r.hostname} · up ${d ? d + 'd ' : ''}${h}h · ${c.cores} cores ${c.model}`;
    $('#res').innerHTML =
      tile('CPU', c.percent, `load ${c.load.join(' / ')} (1 / 5 / 15 min, ${c.cores} cores)${c.asterisk != null ? ` · Asterisk ${c.asterisk}%` : ''}`, 'cpu', 'CPU') +
      tile('RAM', pct(m.used, m.total), `${gb(m.used)} used of ${gb(m.total)} · ${gb(m.available)} free${m.swapTotal ? ` · swap ${gb(m.swapUsed)} / ${gb(m.swapTotal)}` : ''}`, 'mem', 'RAM') +
      r.disks.map((x) => tile(`Storage <span class="mono" style="text-transform:none;letter-spacing:0">${esc(x.mount)}</span>`, pct(x.used, x.total),
        `${gb(x.used)} used of ${gb(x.total)} · ${gb(x.available)} free <span class="mono" style="color:var(--ink-3)" title="${esc(x.device)}">${esc(x.fstype)}</span>`, `disk:${x.mount}`, `Storage ${x.mount}`)).join('');
  };
  // graph icon on a tile -> that resource's history (sys_metrics, one sample per minute, kept 5 days)
  $('#res').onclick = (e) => { const b = e.target.closest('[data-graph]'); if (b) resourceGraph(b.dataset.graph, b.dataset.title); };
  clearInterval(S.resTimer);   // every 5 s while the System page is open
  S.resTimer = setInterval(() => { if (S.page !== 'system') clearInterval(S.resTimer); else if (!document.hidden) bg(resources).catch(() => {}); }, 5000);
  const cfg = async () => {
    const files = await api('GET', '/api/system/config-preview');
    const names = Object.keys(files); let cur = names[0];
    const show = () => { $('#cfgCode').textContent = files[cur]; $$('#cfgTabs button').forEach((b) => b.classList.toggle('on', b.dataset.f === cur)); };
    $('#cfgTabs').innerHTML = names.map((n) => `<button data-f="${n}">${n}</button>`).join('');
    $$('#cfgTabs button').forEach((b) => (b.onclick = () => { cur = b.dataset.f; show(); })); show();
  };
  const cli = async (what) => {
    $$('#cliTabs button').forEach((b) => b.classList.toggle('on', b.dataset.cli === what));
    $('#cliOut').textContent = 'running…';
    try { $('#cliOut').textContent = (await api('GET', `/api/system/cli/${what}`)).output || '(empty)'; } catch (e) { $('#cliOut').textContent = e.message; }
  };
  $$('#cliTabs button').forEach((b) => (b.onclick = () => cli(b.dataset.cli)));
  $('#reapply').onclick = async () => {
    const r = await api('POST', '/api/system/apply');
    r.ok ? toast(`Applied · reloaded ${r.reloaded.join(', ') || 'nothing (reload disabled)'}`) : toast('Apply failed: ' + r.error, true);
    health(); cfg();
  };
  $('#pwf').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#pwErr').textContent = '';
    try { const r = await api('POST', '/api/me/password', formData(e.target)); e.target.reset(); toast(`Password changed${r.otherSessionsEnded ? ` · ${r.otherSessionsEnded} other session(s) signed out` : ''}`); } catch (er) { $('#pwErr').textContent = er.message; }
  });
  resources().catch((e) => ($('#res').textContent = e.message)); health().catch(() => {}); cfg().catch((e) => ($('#cfgCode').textContent = e.message)); cli('endpoints');
};

boot();
