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
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: S.tz });
const dayStr = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: S.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const daysAgo = (n) => dayStr(new Date(Date.now() - n * 86400e3));

const S = { me: null, tz: 'Asia/Kolkata', snap: null, trunks: [], processes: [], dispositions: [], feed: [], ws: null, page: null };

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
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
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; } }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#loginErr').textContent = '';
  try { await api('POST', '/api/login', formData(e.target)); boot(); }
  catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('POST', '/api/logout'); showLogin(); });

async function boot() {
  try { S.me = await api('GET', '/api/me'); } catch { return showLogin(); }
  S.tz = S.me.tz || S.tz;
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#who').textContent = S.me.user;
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
  ws.onclose = () => { S.ws = null; setConn(null); setTimeout(() => { if (!$('#app').classList.contains('hidden')) connectWs(); }, 2000); };
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
  const p = PAGES[page] ? page : 'live';
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
        <div class="panel kpi"><div class="lab">Trunks up</div><div class="val num" id="kTr">0</div><div class="sub" id="kTrS"></div></div>
      </div>
      <div class="grid live-top">
        <div class="panel"><h2>Call flow <span id="gNote" style="text-transform:none;letter-spacing:0;font-weight:500"></span></h2>
          <div class="graph" id="graph"></div>
          <div class="legend"><span>● node flashes on every new call</span><span>edge width = channels in use</span><span>dashed = inactive</span></div></div>
        <div class="panel"><h2>Finished calls <span class="chip" id="feedN">0</span></h2><ul class="feed" id="feed"></ul></div>
      </div>
      <div class="grid two">
        <div class="panel"><h2>Processes</h2><div class="tw"><table><thead><tr><th>Process</th><th>Usage</th><th class="r">Hits/min</th><th class="r">Today</th><th class="r">Peak</th></tr></thead><tbody id="lvP"></tbody></table></div></div>
        <div class="panel"><h2>SIP trunks</h2><div class="tw"><table><thead><tr><th>Trunk</th><th>Usage</th><th>Status</th><th class="r">Peak</th></tr></thead><tbody id="lvT"></tbody></table></div></div>
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
    $('#kLiveS').textContent = `${p}% of trunk capacity · ${fmtInt(s.processCapacity)} sold to processes`;
    $('#kHits').textContent = fmtInt(s.hitsMin);
    $('#kHitsS').textContent = `${fmtInt(s.hitsToday)} calls received today`;
    $('#kPeak').textContent = fmtInt(s.peakToday);
    const up = s.trunks.filter((t) => t.active && t.state === 'online').length;
    $('#kTr').innerHTML = `${up}<small> / ${s.trunks.filter((t) => t.active).length}</small>`;
    $('#kTrS').textContent = s.ariConnected ? 'qualify status from Asterisk' : 'Asterisk not connected';

    $('#lvP').innerHTML = s.processes.length ? s.processes.map((x) => `<tr>
      <td class="t-name"><b>${esc(x.name)}</b><small>${esc(x.code)} → ${esc(x.trunk || 'no trunk')}${x.active ? '' : ' · inactive'}</small></td>
      <td>${usage(x.live, x.limit)}</td><td class="r num">${fmtInt(x.hitsMin)}</td><td class="r num">${fmtInt(x.hitsToday)}</td><td class="r num">${fmtInt(x.peak)}</td></tr>`).join('')
      : `<tr><td colspan="5" class="empty">No processes yet — <a href="#/processes">add one</a></td></tr>`;
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
      if (!procs.length && !trunks.length) svg += `<text x="${W / 2}" y="${H / 2 + 60}" text-anchor="middle" fill="currentColor" opacity=".5">Add a trunk and a process to see the flow</text>`;
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
        <div><span>Host</span><b class="mono">${esc(t.host)}:${t.port}</b><small>${t.transport.toUpperCase()}${t.register ? ' · registers' : ''}</small></div>
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
  const v = t || { allow_inbound: true, port: 5060, transport: 'udp', register: true, max_channels: 30, strip_digits: 0, prefix: '', codecs: 'ulaw,alaw', dial_timeout: 60, active: true };
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
    <div class="fsec">Capacity</div>
    <label>Total channels <small>hard limit on this trunk, 0 = unlimited</small><input name="max_channels" type="number" min="0" value="${v.max_channels}" required></label>
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
    <div class="panel"><div class="tw"><table><thead><tr><th>Process</th><th>Trunk</th><th>Customer IPs</th><th>Live / limit</th><th>Calls allowed</th><th>Dummy number</th><th class="r">DIDs assigned</th><th>Status</th><th></th></tr></thead><tbody id="pBody"><tr><td colspan="9" class="empty">Loading…</td></tr></tbody></table></div></div>`;
  $('#addProc').onclick = async () => { if (!S.trunks.length) S.trunks = await api('GET', '/api/trunks'); procForm(); };
  [S.trunks] = await Promise.all([api('GET', '/api/trunks')]);
  await loadProcs();
};
async function loadProcs() {
  S.processes = await api('GET', '/api/processes');
  const live = Object.fromEntries((S.snap?.processes || []).map((p) => [p.code, p]));
  const body = $('#pBody'); if (!body) return;
  body.innerHTML = S.processes.length ? S.processes.map((p) => {
    const L = live[p.code] || { live: 0 };
    const trunkCell = p.trunk_name ? `${esc(p.trunk_name)}${p.trunk_active ? '' : ' <span class="chip bad">trunk off</span>'}` : '<span class="chip bad">no trunk</span>';
    return `<tr>
      <td class="t-name"><b>${esc(p.name)}</b><small>${esc(p.code)}</small></td>
      <td>${trunkCell}</td>
      <td><span class="mono" style="font-size:12px" title="${esc(p.allowed_ips.split(',').join('\n'))}">${esc(p.allowed_ips.split(',').slice(0, 2).join(', ')) || '<span class="chip bad">none</span>'}${p.allowed_ips.split(',').length > 2 ? '…' : ''}</span></td>
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
  }).join('') : `<tr><td colspan="9" class="empty">No processes yet. Each customer Asterisk that sends you calls is a process.</td></tr>`;
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
    if (!(await confirmBox('Delete process', `Delete <b>${esc(p.name)}</b> (${esc(p.code)})? Calls from its IPs are rejected at once and its DIDs become free. Call history is kept.`))) return;
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
  const v = p || { channel_limit: 10, dummy_cli: sug.dummy_cli, active: true, allowed_ips: '', allow_outbound: true, allow_inbound: true };
  const trunkOpts = `<option value="">— no trunk (calls rejected) —</option>` + S.trunks.map((t) =>
    `<option value="${t.id}" ${v.trunk_id === t.id ? 'selected' : ''}>${esc(t.name)} · ${t.max_channels || '∞'} ch${t.active ? '' : ' (inactive)'}</option>`).join('');
  openModal(p ? `Edit process ${p.name}` : 'Add process', `<form id="pf"><div class="fgrid">
    <label>Process code <small>a-z 0-9 _ · Asterisk endpoint p_code</small><input name="code" value="${esc(v.code || '')}" required pattern="[a-z0-9_]{2,32}"></label>
    <label>Display name<input name="name" value="${esc(v.name || '')}" placeholder="Customer / campaign" required></label>
    <label>SIP trunk<select name="trunk_id">${trunkOpts}</select></label>
    <label>Channel limit <small>max concurrent calls for this customer</small><input name="channel_limit" type="number" min="1" value="${v.channel_limit}" required></label>
    <p class="hint full" id="capHint"></p>
    <div class="fsec">Customer server</div>
    <label class="full">Customer server IPs <small>calls are accepted only from these IPs · comma separated, CIDR allowed · each IP belongs to one process · the first single IP receives inbound DID calls</small><input name="allowed_ips" value="${esc(v.allowed_ips || '')}" placeholder="203.0.113.25, 198.51.100.0/28" class="mono" required></label>
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
    // DID picker for the selected trunk: tick single DIDs; free DIDs + this process's DIDs are selectable.
    // Small trunks show one checkbox per DID, big ones (> DID_GRID) a text box with runs like 1240-1249.
    const pick = $('#didPick', c);
    const DID_GRID = 2000;
    const bi = (x) => BigInt(x), cmpDid = (a, b) => a.length - b.length || (bi(a) < bi(b) ? -1 : bi(a) > bi(b) ? 1 : 0);
    const nums = (r) => { const out = [], len = r.first_did.length; for (let n = bi(r.first_did); n <= bi(r.last_did); n++) out.push(n.toString().padStart(len, '0')); return out; };
    const runs = (list) => [...list].sort(cmpDid).reduce((out, d) => {
      const l = out[out.length - 1];
      if (l && l.b.length === d.length && bi(d) === bi(l.b) + 1n) l.b = d; else out.push({ a: d, b: d });
      return out;
    }, []).map((x) => (x.a === x.b ? x.a : `${x.a}-${x.b}`));
    let sel = new Set(), big = false, curTrunk;
    const drawDids = () => {
      const t = S.trunks.find((x) => x.id === +f.trunk_id.value);
      const ranges = t ? t.did_ranges || [] : [];
      if (!t) { pick.innerHTML = '<p class="hint">Pick a trunk to see its DIDs.</p>'; return; }
      if (!ranges.length) { pick.innerHTML = `<p class="hint">${esc(t.name)} has no DID ranges — add them on the SIP trunks page.</p>`; return; }
      const mine = (r) => p && r.process_id === p.id, other = (r) => r.process_id && !mine(r);
      if (curTrunk !== t.id) { curTrunk = t.id; sel = new Set(ranges.filter(mine).flatMap(nums)); }
      const total = ranges.reduce((s, r) => s + didCount(r), 0);
      const freeN = ranges.filter((r) => !other(r)).reduce((s, r) => s + didCount(r), 0);
      big = total > DID_GRID;
      const warn = t.allow_inbound === false ? `<p class="hint warn">Inbound calls are blocked on ${esc(t.name)} — assigned DIDs only take effect when you allow inbound on the trunk.</p>` : '';
      if (big) {   // too many numbers for checkboxes: edit the runs as text
        pick.innerHTML = warn + `<textarea id="didText" class="mono" rows="3" placeholder="e.g. 1240, 1245-1250"></textarea>
          <p class="hint">Comma separated DIDs or runs (first-last). ${fmtInt(freeN)} of ${fmtInt(total)} DIDs on ${esc(t.name)} can be given to this process:
          ${ranges.filter((r) => !other(r)).map((r) => `<span class="mono">${esc(didLabel(r))}</span>`).join(', ')}</p>`;
        $('#didText', pick).value = ranges.filter(mine).map((r) => (r.first_did === r.last_did ? r.first_did : `${r.first_did}-${r.last_did}`)).join(', ');
        return;
      }
      pick.innerHTML = warn + `<div class="did-tools"><b id="didSum"></b>
          <input id="didType" class="mono" placeholder="Type DIDs: 1240, 1245-1250"><button type="button" class="btn sm" id="didTick">Tick</button>
          <button type="button" class="btn sm" id="didAll">All free</button><button type="button" class="btn sm" id="didNone">Clear</button></div>
        <p class="hint warn hidden" id="didErr"></p>` +
        ranges.map((r) => other(r)
          ? `<div class="did-grp taken"><small><span class="mono">${esc(didLabel(r))}</span> · ${fmtInt(didCount(r))} DID${didCount(r) === 1 ? '' : 's'} · assigned to <b>${esc(r.process_code)}</b></small></div>`
          : `<div class="did-grp">${r.note ? `<small>${esc(r.note)}</small>` : ''}<div class="did-chips">${nums(r).map((d) =>
              `<label class="dchip"><input type="checkbox" value="${d}" ${sel.has(d) ? 'checked' : ''}><span class="mono">${d}</span></label>`).join('')}</div></div>`).join('');
      const boxes = $$('.dchip input', pick);
      const sum = () => { $('#didSum', pick).textContent = `${sel.size} selected · ${fmtInt(freeN - sel.size)} free`; };
      const setAll = (fn) => { boxes.forEach((b) => { b.checked = fn(b.value); b.checked ? sel.add(b.value) : sel.delete(b.value); }); sum(); };
      boxes.forEach((b) => (b.onchange = () => { b.checked ? sel.add(b.value) : sel.delete(b.value); sum(); }));
      $('#didAll', pick).onclick = () => setAll(() => true);
      $('#didNone', pick).onclick = () => setAll(() => false);
      const tick = () => {   // typed DIDs / runs -> tick them; unknown or taken ones are reported
        const err = $('#didErr', pick), have = new Set(boxes.map((b) => b.value)), bad = [], want = new Set();
        for (const it of $('#didType', pick).value.split(/[\s,;]+/).filter(Boolean)) {
          const [a, b = a] = it.replace(/\+/g, '').split('-');
          if (!/^[0-9]{4,15}$/.test(a) || !/^[0-9]{4,15}$/.test(b) || a.length !== b.length || bi(a) > bi(b) || bi(b) - bi(a) > 5000n) { bad.push(it); continue; }
          for (let n = bi(a); n <= bi(b); n++) { const d = n.toString().padStart(a.length, '0'); have.has(d) ? want.add(d) : bad.push(d); }
        }
        want.forEach((d) => sel.add(d)); boxes.forEach((b) => { b.checked = sel.has(b.value); }); sum();
        err.classList.toggle('hidden', !bad.length);
        err.textContent = bad.length ? `Not free on ${t.name}: ${runs(bad.filter((x) => /^[0-9]+$/.test(x))).concat(bad.filter((x) => !/^[0-9]+$/.test(x))).slice(0, 20).join(', ')}` : '';
        if (!bad.length) $('#didType', pick).value = '';
      };
      $('#didTick', pick).onclick = tick;
      $('#didType', pick).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); tick(); } };
      sum();
    };
    f.trunk_id.addEventListener('change', drawDids); drawDids();
    $('#sugCli', c).onclick = async () => { f.dummy_cli.value = (await api('GET', '/api/processes/suggest')).dummy_cli; };
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formData(f); d.active = f.active.checked;
      const dir = (k) => { const b = $(`.dirbox[data-dir="${k}"]`, c);
        return [$('.d-allow', b).checked, $('.d-timed', b).checked ? { days: $$('.daypick input:checked', b).map((x) => x.value), from: $('.d-from', b).value, to: $('.d-to', b).value } : null]; };
      [d.allow_outbound, d.out_hours] = dir('out'); [d.allow_inbound, d.in_hours] = dir('in');
      if (!f.trunk_id.value) d.dids = [];
      else if (big) d.dids = $('#didText', pick).value.split(/[\s,;]+/).filter(Boolean);
      else if ($('.did-tools', pick)) d.dids = runs(sel);
      try {
        const r = await api(p ? 'PUT' : 'POST', p ? `/api/processes/${p.id}` : '/api/processes', d);
        S.trunks = await api('GET', '/api/trunks');   // DID owners changed
        closeModal(); applyToast(r, 'Process'); await loadProcs();
        if (!p) peerConfig(S.processes.find((x) => x.id === r.id));
      } catch (err) { $('#pErr').textContent = err.message; }
    });
  });
}
async function peerConfig(p) {
  const c = await api('GET', `/api/processes/${p.id}/peer-config`);
  openModal(`Peer config · ${p.name}`, `<div class="mbody">
    <p class="hint" style="margin-bottom:12px">Give these details to the customer. They point their Asterisk at your server; calls over ${c.limit} at once get <b>503</b>.</p>
    <div class="cred">
      <span>Server</span><code>${esc(c.publicIp)}:${c.port}</code><button class="btn sm" data-copy="${esc(c.publicIp)}">Copy</button>
      ${c.auth_type === 'password' ? `<span>Username</span><code>${esc(c.username)}</code><button class="btn sm" data-copy="${esc(c.username)}">Copy</button>
      <span>Password</span><code>${esc(c.password)}</code><button class="btn sm" data-copy="${esc(c.password)}">Copy</button>` : `<span>Auth</span><code>by IP: ${esc(p.allowed_ips)}</code><span></span>`}
      <span>Channels</span><code>${c.limit}</code><span></span>
      <span>Calls</span><div class="dirs">${dirChip('OUT', p.allow_outbound !== false, p.out_hours)}${dirChip('IN', p.allow_inbound !== false, p.in_hours)}</div><span></span>
    </div>
    <div class="tabs"><button class="on" data-tab="pjsip">PJSIP</button><button data-tab="chan_sip">chan_sip / ViciDial</button></div>
    <pre class="code" id="peerCode"></pre>
    <div class="mfoot">${c.auth_type === 'password' ? '<button class="btn danger" id="regen">Regenerate password</button>' : ''}<button class="btn" id="copyCfg">Copy config</button><button class="btn primary" data-close>Done</button></div></div>`,
  (card) => {
    let tab = 'pjsip';
    const show = () => { $('#peerCode').textContent = c[tab]; $$('.tabs button', card).forEach((b) => b.classList.toggle('on', b.dataset.tab === tab)); };
    $$('.tabs button', card).forEach((b) => (b.onclick = () => { tab = b.dataset.tab; show(); })); show();
    $$('[data-copy]', card).forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
    $('#copyCfg', card).onclick = () => copy(c[tab]);
    const rg = $('#regen', card);
    if (rg) rg.onclick = async () => {
      if (!(await confirmBox('Regenerate password', 'The customer must update their config — their calls fail until they do.', 'Regenerate'))) return;
      try { applyToast(await api('POST', `/api/processes/${p.id}/regenerate`), 'Password'); await loadProcs(); peerConfig(p); } catch (e) { toast(e.message, true); }
    };
  });
}
function copy(text) { navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed — select and copy manually', true)); }

// =================================================================== CDR
PAGES.cdr = async (main) => {
  const [procs, trunks] = await Promise.all([api('GET', '/api/processes'), api('GET', '/api/trunks')]);
  main.innerHTML = `<div class="head"><div><h1>CDR report</h1><p>Every call with its disposition. Times in ${esc(S.tz)}.</p></div></div>
    <div class="panel"><form class="filters" id="cf">
      <label>From<input type="date" name="from" value="${dayStr()}"></label>
      <label>To<input type="date" name="to" value="${dayStr()}"></label>
      <label>Process<select name="process"><option value="">All</option>${procs.map((p) => `<option value="${esc(p.code)}">${esc(p.code)}</option>`).join('')}</select></label>
      <label>Trunk<select name="trunk"><option value="">All</option>${trunks.map((t) => `<option>${esc(t.name)}</option>`).join('')}</select></label>
      <label>Disposition<select name="disposition"><option value="">All</option>${S.dispositions.map((d) => `<option value="${d.code}">${esc(dispName(d.code))}</option>`).join('')}</select></label>
      <label>Direction<select name="direction"><option value="">All</option><option value="out">Outbound</option><option value="in">Inbound DID</option></select></label>
      <label>Number<input name="number" placeholder="contains…" class="mono"></label>
      <label>DID<input name="did" placeholder="exact DID" class="mono"></label>
      <div class="actions"><button class="btn primary">Search</button><button type="button" class="btn" id="csv">Export CSV</button></div>
    </form><div class="summary" id="cSum"></div>
    <div class="tw"><table><thead><tr><th>Start</th><th>Process</th><th>Trunk</th><th>Number</th><th>Sent as</th><th>Caller ID</th><th>DID</th><th>Disposition</th><th class="r">Ring</th><th class="r">Talk</th><th class="r">Cause</th></tr></thead><tbody id="cBody"></tbody></table></div>
    <div class="pager" id="cPager"></div></div>`;
  const f = $('#cf'); let page = 1;
  const qs = () => new URLSearchParams({ ...formData(f), page }).toString();
  const load = async () => {
    $('#cBody').innerHTML = `<tr><td colspan="11" class="empty">Loading…</td></tr>`;
    try {
      const r = await api('GET', '/api/reports/calls?' + qs());
      const ans = (r.byDisposition.find((d) => d.disposition === 'ANSWERED') || {}).n || 0;
      $('#cSum').innerHTML = `<span class="chip">${fmtInt(r.total)} calls</span><span class="chip">talk ${fmtDur(r.talkSec)}</span><span class="chip">ASR ${pct(ans, r.total)}%</span>` +
        r.byDisposition.map((d) => `<span class="chip ${DISP_CLASS[d.disposition] || ''}">${esc(dispName(d.disposition))} ${fmtInt(d.n)}</span>`).join('');
      $('#cBody').innerHTML = r.rows.length ? r.rows.map((c) => `<tr>
        <td class="mono" style="font-size:12.5px;white-space:nowrap">${fmtTime(c.start_time)}</td><td>${esc(c.process_code || '')}</td><td>${esc(c.trunk_name || '')}</td>
        <td class="mono">${c.direction === 'in' ? '<span class="chip info" title="inbound call to a DID">in</span> ' : ''}${esc(c.dialed || '')}</td><td class="mono" style="color:var(--ink-2)">${esc(c.sent_number || '')}</td>
        <td class="mono" style="font-size:12.5px">${esc(c.cli_out || c.cli_in || '')}</td>
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
      <label>Group by<select name="scope"><option value="process">Process</option><option value="trunk">Trunk</option><option value="did">DID</option></select></label>
      <label>Only<select name="ref"><option value="">All</option></select></label>
      <div class="actions"><button class="btn primary">Show</button></div></form></div>
    <div class="panel" style="margin-bottom:14px"><h2>Calls per day</h2><div class="body" id="sChart"></div></div>
    <div class="panel"><div class="tw"><table><thead><tr><th>Day</th><th id="refH">Process</th><th class="r">Total</th><th class="r">Answered</th><th class="r">Busy</th><th class="r">No ans.</th><th class="r">Cancel</th><th class="r">Congest.</th><th class="r">Failed</th><th class="r" title="trunk / far end unreachable">SIP down</th><th class="r" title="CHANNEL_LIMIT + TRUNK_LIMIT + BLOCKED + NO_ROUTE + INVALID + OFF_HOURS + NO_HEADER + INVALID_DID">Rejected</th><th class="r">ASR</th><th class="r">ACD</th><th class="r">Talk</th><th class="r">Peak ch</th></tr></thead><tbody id="sBody"></tbody></table></div></div>`;
  const f = $('#sf');
  const fillRefs = async () => {
    const list = f.scope.value === 'trunk' ? (await api('GET', '/api/trunks')).map((t) => t.name)
      : f.scope.value === 'did' ? []   // can be thousands: show all DIDs with calls
      : (await api('GET', '/api/processes')).map((p) => p.code);
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
  const load = async () => {
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
  TRUNK_LIMIT: 'The trunk max channels was full.',
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
    <div class="panel"><div class="tw"><table><thead><tr><th>Internal code</th><th>Shown as</th><th>Label</th><th>Set by</th><th>SIP response</th><th>Meaning</th><th></th></tr></thead><tbody id="dBody"></tbody></table></div></div>`;
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
const DIAG_TABS = [['issues', 'Issues'], ['sip', 'SIP trace'], ['rtp', 'RTP / audio'], ['pcap', 'Packet capture'], ['log', 'Asterisk log'], ['lookup', 'Call lookup']];
const ago = (ms) => fmtDur(Math.max(0, Math.round((Date.now() - ms) / 1000)));
const durBetween = (a, b) => fmtDur(Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000)));
// ip[:port] -> "trunk x" / "proc y" / "SIPDist"
const epName = (ep) => { const ip = String(ep).replace(/:\d+$/, ''); return Diag.names[ip] || ''; };
function diagPoll(fn, ms) {
  clearInterval(Diag.timer);
  const tab = Diag.tab;
  Diag.timer = setInterval(() => { if (S.page !== 'diag' || Diag.tab !== tab || document.hidden) return; fn().catch(() => {}); }, ms);
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
    $('#iHist').innerHTML = r.history.length ? r.history.map((i) => `<tr><td><span class="chip ${i.severity === 'critical' ? 'bad' : 'warn'}">${esc(i.severity)}</span></td>
      <td>${esc(i.title)}</td><td style="font-size:12.5px;color:var(--ink-2)">${esc(i.detail || '')}</td>
      <td class="mono" style="font-size:12px;white-space:nowrap">${fmtTime(i.opened_at)}</td><td class="mono" style="font-size:12px;white-space:nowrap">${fmtTime(i.closed_at)}</td>
      <td class="r num">${durBetween(i.opened_at, i.closed_at)}</td></tr>`).join('') : `<tr><td colspan="6" class="empty">No closed issues yet.</td></tr>`;
  };
  const load = async () => draw(await api('GET', '/api/diag/issues'));
  $('#iRun').onclick = async () => { $('#iRun').disabled = true; try { draw(await api('POST', '/api/diag/issues/run')); toast('Checks done'); } finally { $('#iRun').disabled = false; } };
  await load(); diagPoll(load, 15000);
};

// ---------------------------------------------------------------- SIP trace (sngrep-like)
const STATE_CLS = { 'IN CALL': 'ok', COMPLETED: 'ok', RINGING: 'info', 'CALL SETUP': 'info', REJECTED: 'bad', CANCELLED: 'warn' };
DiagTab.sip = async (el) => {
  el.innerHTML = `<div class="panel" style="margin-bottom:14px"><form class="filters" id="stf">
      ${targetField()}
      <label>Run for<select name="minutes"><option value="5">5 min</option><option value="10" selected>10 min</option><option value="30">30 min</option><option value="60">60 min</option></select></label>
      <label class="check" style="max-width:none" title="Live messages always show REGISTER / OPTIONS; this adds them to the Calls list too"><input type="checkbox" name="keepNoise"> REGISTER/OPTIONS in Calls</label>
      <div class="actions"><button class="btn primary" id="stGo">Start trace</button><button type="button" class="btn" id="stStop">Stop</button><button type="button" class="btn" id="stClr">Clear</button></div>
    </form><div class="summary" id="stSum"></div>
    <div class="tabs sub" id="stView"><button data-v="live">Live messages <small>INVITE · 100 · 180 · 200 · BYE · REGISTER…</small></button><button data-v="calls">Calls <small>one row per call, like sngrep</small></button></div>
    <div id="vLive">
      <div class="filters live-f">
        <span class="seg">${[['call', 'Calls (INVITE/ACK/BYE/CANCEL)', 1], ['register', 'REGISTER', 1], ['options', 'OPTIONS', 0], ['other', 'Other', 1]]
          .map(([v, l, on]) => `<label class="check"><input type="checkbox" class="lt" value="${v}" ${on ? 'checked' : ''}> ${l}</label>`).join('')}</span>
        <label style="max-width:260px">Search<input id="lmQ" class="mono" placeholder="number, Call-ID, IP, any text"></label>
        <span class="seg"><label class="check"><input type="checkbox" id="lmFull"> full text <small>like tcpdump -A</small></label>
          <label class="check"><input type="checkbox" id="lmScroll" checked> auto-scroll</label></span>
        <div class="actions"><button type="button" class="btn sm" id="lmPause">Pause</button><button type="button" class="btn sm" id="lmEmpty">Clear view</button></div>
      </div>
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
  let after = 0, paused = false, rows = 0;
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
  const lmReset = () => { after = 0; rows = 0; list.innerHTML = '<div class="empty">Waiting for SIP messages…</div>'; };
  const live = async () => {
    if (paused) return;
    if (!types()) { rows = 0; list.innerHTML = '<div class="empty">Tick at least one message type.</div>'; return; }
    const r = await api('GET', '/api/diag/sip/messages?' + new URLSearchParams({ after, types: types(), q: $('#lmQ').value.trim() }));
    status(r.status);
    if (!r.messages.length) {
      if (!rows) list.innerHTML = `<div class="empty">${r.status.running ? 'Waiting for SIP messages…' : 'Start a trace: every SIP request and response shows up here as it happens.'}</div>`;
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
      <label class="check" style="max-width:none"><input type="checkbox" name="VERBOSE"> VERBOSE</label>
      <label style="max-width:120px">Lines<select name="lines"><option>200</option><option selected>500</option><option>1000</option><option>2000</option></select></label>
      <div class="actions"><button class="btn primary">Search</button></div></form>
    <div class="summary" id="lSum"></div><div class="body" style="padding-top:0"><pre class="code logbox" id="lOut">Loading…</pre></div></div>`;
  const f = $('#lf');
  const load = async () => {
    const levels = ['ERROR', 'WARNING', 'NOTICE', 'VERBOSE', 'DEBUG'].filter((l) => f[l] ? f[l].checked : false);
    const r = await api('GET', '/api/diag/log?' + new URLSearchParams({ q: f.q.value.trim(), lines: f.lines.value, levels: levels.join(',') }));
    $('#lSum').innerHTML = `<span class="chip mono">${esc(r.file)}</span><span class="chip">${fmtInt(r.lines.length)} lines</span><span class="chip">searched last ${fmtInt(Math.round(r.scannedBytes / 1024))} KB</span>`;
    $('#lOut').innerHTML = r.lines.length ? r.lines.map((l) => {
      const lv = (/\]\s+([A-Z]+)\[/.exec(l) || [])[1];
      return `<span class="${LOG_CLS[lv] || ''}">${esc(l).replace(/\[(C-[0-9a-f]{8})\]/g, '[<a href="#" data-cid="$1">$1</a>]')}</span>`;
    }).join('\n') : 'No matching lines.';
    $('#lOut').scrollTop = $('#lOut').scrollHeight;
    $$('#lOut [data-cid]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); f.q.value = a.dataset.cid; f.VERBOSE.checked = true; load().catch((er) => toast(er.message, true)); }));
  };
  f.addEventListener('submit', (e) => { e.preventDefault(); load().catch((er) => toast(er.message, true)); });
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

// =================================================================== SYSTEM
PAGES.system = async (main) => {
  main.innerHTML = `<div class="head"><div><h1>System</h1><p>Health, generated Asterisk config, live Asterisk views and audit log.</p></div>
    <div class="actions"><button class="btn" id="reapply">Re-apply config to Asterisk</button></div></div>
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
      <div class="panel"><h2>Audit log</h2><div class="tw" style="max-height:380px;overflow:auto"><table><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Object</th></tr></thead><tbody id="audit"></tbody></table></div></div>
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
  const audit = async () => {
    const rows = await api('GET', '/api/system/audit?limit=150');
    $('#audit').innerHTML = rows.length ? rows.map((r) => `<tr><td class="mono" style="font-size:12px;white-space:nowrap">${fmtTime(r.at)}</td><td>${esc(r.admin || '')}</td><td>${esc(r.action)}</td>
      <td class="mono" style="font-size:12px">${esc(r.entity || '')} ${esc(r.details ? Object.values(r.details).join(' ') : '')}</td></tr>`).join('') : `<tr><td colspan="4" class="empty">Nothing yet</td></tr>`;
  };
  $$('#cliTabs button').forEach((b) => (b.onclick = () => cli(b.dataset.cli)));
  $('#reapply').onclick = async () => {
    const r = await api('POST', '/api/system/apply');
    r.ok ? toast(`Applied · reloaded ${r.reloaded.join(', ') || 'nothing (reload disabled)'}`) : toast('Apply failed: ' + r.error, true);
    health(); cfg(); audit();
  };
  $('#pwf').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#pwErr').textContent = '';
    try { await api('POST', '/api/system/password', formData(e.target)); e.target.reset(); toast('Password changed'); } catch (er) { $('#pwErr').textContent = er.message; }
  });
  health().catch(() => {}); cfg().catch((e) => ($('#cfgCode').textContent = e.message)); cli('endpoints'); audit().catch(() => {});
};

boot();
