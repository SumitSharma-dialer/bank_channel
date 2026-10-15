'use strict';
// Pure functions: DB rows -> Kamailio files (kamailio.cfg, data.lua, dispatcher.list, dbtext/uacreg, rtpengine.conf).
// No I/O here (unit tested). The routing logic itself is static: src/kamailio/sipdist.lua reads data.lua.
const { didParts, NAME_RE, DEFAULT_REJECT } = require('../asterisk/render');

const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const NUM_RE = /^\+?[0-9]{0,20}$/;
const DUMMY_RE = /^[0-9]{4,20}$/;
const WDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];   // Lua os.date('*t').wday: 1 = Sunday
const SIP_REJECT = new Set([403, 404, 408, 480, 484, 486, 488, 500, 502, 503]);   // same choice as the Asterisk renderer
// Asterisk codec name -> rtpengine / SDP name (all of these can be transcoded by rtpengine)
const CODEC = { ulaw: 'PCMU', alaw: 'PCMA', g722: 'G722', g729: 'G729', gsm: 'GSM', opus: 'opus', speex: 'speex', g726: 'G726-32' };

const clean = (v) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]/g, '').trim();
const ips = (s) => String(s || '').split(/[\s,]+/).map(clean).filter(Boolean);
// "user@domain" (IMS carriers) -> { user, domain }; anything else -> null. See src/asterisk/render.js.
const imsUser = (u) => { const m = /^([^@\s]+)@([A-Za-z0-9.-]+)$/.exec(clean(u)); return m ? { user: m[1], domain: m[2] } : null; };
const codecs = (s) => [...new Set(String(s || 'ulaw,alaw').split(',').map((c) => CODEC[c.trim().toLowerCase()]).filter(Boolean))];
const hoursOf = (v) => (typeof v === 'string' ? JSON.parse(v) : v) || null;

// JS value -> Lua literal
function lua(v, ind = '') {
  if (v == null) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
  if (typeof v === 'string') return '"' + clean(v).replace(/[\\"]/g, '\\$&') + '"';
  const n = ind + '  ';
  if (Array.isArray(v)) return v.length ? `{\n${v.map((x) => n + lua(x, n)).join(',\n')}\n${ind}}` : '{}';
  const keys = Object.keys(v).filter((k) => v[k] != null);
  return keys.length ? `{\n${keys.map((k) => `${n}[${lua(k)}] = ${lua(v[k], n)}`).join(',\n')}\n${ind}}` : '{}';
}

// "a.b.c.d/n" -> [network >> (32 - n), 2^(32 - n)]: Lua 5.1 has no bit operators, it checks floor(ip / div) == net
function cidr(s) {
  const m = /^((?:\d{1,3}\.){3}\d{1,3})\/(\d{1,2})$/.exec(s);
  if (!m || +m[2] > 32) return null;
  const n = m[1].split('.').reduce((a, x) => a * 256 + +x, 0), div = 2 ** (32 - +m[2]);
  return [Math.floor(n / div), div];
}

// working time { days, from: 'HH:MM', to: 'HH:MM' } -> { days: { 2: true, .. }, from: minutes, to: minutes }
function hours(h) {
  if (!h) return null;
  const hm = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
  const days = WDAYS.map((d, i) => ((h.days || []).includes(d) ? i + 1 : 0)).filter(Boolean);
  const a = hm.exec(h.from), b = hm.exec(h.to);
  if (!days.length || !a || !b) throw new Error(`invalid working time ${JSON.stringify(h)}`);
  return { days: Object.fromEntries(days.map((d) => [String(d), true])), from: +a[1] * 60 + +a[2], to: +b[1] * 60 + +b[2] };
}

const range = (r, extra) => { const d = didParts(r); return { len: d.len, first: String(r.first_did), last: String(r.last_did), ...extra }; };

// Everything the Lua script needs. opts: { selfIp, sipPort, realm, rpcKey, evKey, sizesKey, routeUrl, rejectCodes,
// hostIps: { hostname: [ip] } (trunk hosts that are names, resolved by the caller) }
function buildData(trunks, processes, opts) {
  const reject = { ...DEFAULT_REJECT };
  for (const [d, c] of Object.entries(opts.rejectCodes || {})) if (d in DEFAULT_REJECT && SIP_REJECT.has(+c)) reject[d] = +c;
  const byId = new Map(trunks.map((t) => [t.id, t]));
  const procById = new Map(processes.map((p) => [p.id, p]));
  const D = { self_ip: opts.selfIp, sip_port: opts.sipPort, realm: opts.realm || 'asterisk', rpc_key: opts.rpcKey,
    ev_key: opts.evKey, sizes_key: opts.sizesKey, route_url: opts.routeUrl || '', reject,
    procs: {}, trunks: {}, ip2proc: {}, cidr2proc: [], user2proc: {}, ip2trunk: {} };

  const ipUse = new Map();
  for (const p of processes) for (const i of ips(p.allowed_ips)) ipUse.set(i, (ipUse.get(i) || 0) + 1);
  for (const p of processes) {
    if (!NAME_RE.test(p.code)) throw new Error(`invalid process name "${p.code}"`);
    const byIp = p.auth_type === 'ip';
    const list = ips(p.allowed_ips);
    const fixed = list.filter((i) => IP_RE.test(i));
    const t = p.trunk_id ? byId.get(p.trunk_id) : null;
    D.procs[p.code] = {
      code: p.code, active: !!p.active, out: p.allow_outbound !== false, inb: p.allow_inbound !== false,
      auth: byIp ? 'ip' : 'password', user: byIp ? null : clean(p.sip_username), pass: byIp ? null : clean(p.sip_password),
      ips: Object.fromEntries(fixed.map((i) => [i, true])), cidrs: list.map(cidr).filter(Boolean), locked: list.length > 0,
      limit: +p.channel_limit || 0, trunk: t && t.active ? t.name : null, trunk_name: t ? t.name : null,
      dummy: DUMMY_RE.test(String(p.dummy_cli || '')) ? String(p.dummy_cli) : null,
      out_hours: hours(hoursOf(p.out_hours)), in_hours: hours(hoursOf(p.in_hours)),
      // inbound DID calls: IP auth -> the first fixed IP; password auth -> wherever the customer registered from
      dst: byIp && fixed[0] ? `sip:${fixed[0]}:${+p.sip_port || 5060}` : null,
      codecs: codecs(p.codecs),
    };
    // same identification rules as the Asterisk renderer: IP processes by every IP / CIDR, password processes by
    // an IP no other process uses (the password is still checked), else by user name
    if (byIp) {
      for (const i of fixed) D.ip2proc[i] = p.code;
      for (const c of list.map(cidr).filter(Boolean)) D.cidr2proc.push([...c, p.code]);
    } else {
      for (const i of fixed) if (ipUse.get(i) === 1) D.ip2proc[i] = p.code;
      if (p.sip_username) D.user2proc[clean(p.sip_username)] = p.code;
    }
  }

  for (const t of trunks.filter((x) => x.active)) {
    if (!NAME_RE.test(t.name)) throw new Error(`invalid trunk name "${t.name}"`);
    const host = clean(t.host);
    if (!IP_RE.test(host) && !HOST_RE.test(host)) throw new Error(`invalid host "${host}" on trunk ${t.name}`);
    const addrs = IP_RE.test(host) ? [host] : ((opts.hostIps || {})[host] || []);
    const hasAuth = !!(t.username && t.password);
    const ranges = t.did_ranges || [];
    const inbound = t.allow_inbound !== false ? ranges : [];
    D.trunks[t.name] = {
      name: t.name, host, port: +t.port || 5060, tcp: t.transport === 'tcp',
      user: hasAuth ? clean(t.username) : null, pass: hasAuth ? clean(t.password) : null,
      from_user: t.from_user ? clean(t.from_user) : null, from_domain: t.from_domain ? clean(t.from_domain) : (imsUser(t.username) || {}).domain || null,
      max: +t.max_channels || 0, cps: Math.max(0, Math.min(1000, +t.cps || 0)),
      prefix: NUM_RE.test(t.prefix || '') ? (t.prefix || '') : '', strip: Math.max(0, Math.min(10, +t.strip_digits || 0)),
      cli_prefix: NUM_RE.test(t.cli_prefix || '') ? (t.cli_prefix || '') : '',
      timeout: Math.max(5, Math.min(300, +t.dial_timeout || 60)), codecs: codecs(t.codecs),
      cli_ranges: ranges.filter((r) => r.use_as_cli).map((r) => range(r)),
      in_ranges: inbound.map((r) => range(r, { proc: r.process_id && procById.get(r.process_id) ? procById.get(r.process_id).code : null })),
    };
    for (const a of addrs) D.ip2trunk[a] = t.name;
  }
  return D;
}

const HEADER = (c, what) => `${c} ${what}\n${c} GENERATED by SIP Channel Distributor at ${new Date().toISOString()}\n${c} DO NOT EDIT — changes are overwritten from the web UI.\n\n`;

function renderData(trunks, processes, opts) {
  return HEADER('--', 'Trunks, processes and DID ranges for sipdist.lua (Kamailio)') + 'return ' + lua(buildData(trunks, processes, opts)) + '\n';
}

// OPTIONS ping targets (dispatcher): set 1 = trunks, set 2 = fixed IPs of IP-auth processes (monitor only, never used
// for routing). Kamailio pings every 60 s; `dispatcher.list` then says active / inactive.
function renderDispatcher(trunks, processes) {
  let out = HEADER('#', 'OPTIONS ping targets: setid destination flags priority attrs');
  for (const t of trunks.filter((x) => x.active)) {
    out += `1 sip:${clean(t.host)}:${+t.port || 5060}${t.transport === 'tcp' ? ';transport=tcp' : ''} 0 0 duid=t_${t.name}\n`;
  }
  for (const p of processes.filter((x) => x.active && x.auth_type === 'ip')) {
    for (const i of ips(p.allowed_ips).filter((x) => IP_RE.test(x))) out += `2 sip:${i}:${+p.sip_port || 5060} 0 0 duid=p_${p.code}_${i}\n`;
  }
  return out;
}

// db_text table read by the uac module: one row per trunk that registers at its carrier
const UACREG_COLS = 'id(int,auto) l_uuid(string) l_username(string) l_domain(string) r_username(string) r_domain(string) realm(string,null) ' +
  'auth_username(string) auth_password(string) auth_ha1(string,null) auth_proxy(string) expires(int) flags(int) reg_delay(int) contact_addr(string) socket(string,null)';
const dbt = (v) => clean(v).replace(/[\\:]/g, '\\$&');
function renderUacreg(trunks, opts) {
  let out = UACREG_COLS + '\n', id = 1;
  const reg = trunks.filter((x) => x.active && x.register && x.username && x.password);
  const uses = new Map();
  for (const t of reg) uses.set(clean(t.username), (uses.get(clean(t.username)) || 0) + 1);
  for (const t of reg) {
    const host = clean(t.host), port = +t.port || 5060, user = clean(t.username);
    // "user@domain": register user at domain through host:port, authenticate with the full username
    const ims = imsUser(user), aor = ims ? ims.user : user;
    // l_uuid is the user part of the Contact Kamailio registers: the username, like Asterisk's contact_user
    const row = [id++, uses.get(user) === 1 ? aor : `t_${t.name}`, aor, opts.selfIp, aor, ims ? ims.domain : port === 5060 ? host : `${host}:${port}`, '',
      user, t.password, '', `sip:${host}:${port}${t.transport === 'tcp' ? ';transport=tcp' : ''}`, 3600, 0, 0,
      `${opts.advertiseIp || opts.selfIp}:${opts.sipPort}`, ''];
    out += row.map(dbt).join(':') + '\n';
  }
  return out;
}
const renderDbVersion = () => 'id(int,auto) table_name(string) table_version(int)\n1:version:1\n2:uacreg:5\n';

// opts: { selfIp, advertiseIp, sipPort, rpcPort, dir, redis: { host, port, pass }, children, ngPort, debug }
function renderCfg(o) {
  const adv = o.advertiseIp && o.advertiseIp !== o.selfIp ? ` advertise ${o.advertiseIp}:${o.sipPort}` : '';
  const q = (s) => String(s).replace(/[\\"]/g, '\\$&');
  const redis = `name=sd;addr=${o.redis.host};port=${o.redis.port};db=0${o.redis.pass ? ';pass=' + o.redis.pass : ''}`;
  return `#!KAMAILIO
${HEADER('#', 'Kamailio for the SIP Channel Distributor. Routing logic: sipdist.lua, data: data.lua')}
debug=${+o.debug || 2}
log_stderror=no
log_facility=LOG_DAEMON
log_name="kamailio"
children=${+o.children || 16}
tcp_children=4
auto_aliases=no
dns=no
rev_dns=no
dns_try_ipv6=no
sip_warning=0
server_header="Server: SIPDist"
user_agent_header="User-Agent: SIPDist"
tcp_accept_no_cl=yes
tcp_connection_lifetime=3605
max_while_loops=1000

listen=udp:${o.selfIp}:${o.sipPort}${adv}
listen=tcp:${o.selfIp}:${o.sipPort}${adv}
# JSON-RPC over HTTP for the web app (this host only, shared key checked in sipdist.lua)
listen=tcp:127.0.0.1:${o.rpcPort}

loadmodule "kex.so"
loadmodule "corex.so"
loadmodule "tm.so"
loadmodule "tmx.so"
loadmodule "sl.so"
loadmodule "rr.so"
loadmodule "pv.so"
loadmodule "maxfwd.so"
loadmodule "textops.so"
loadmodule "siputils.so"
loadmodule "xlog.so"
loadmodule "ctl.so"
loadmodule "jsonrpcs.so"
loadmodule "xhttp.so"
loadmodule "kemix.so"
loadmodule "htable.so"
loadmodule "db_text.so"
loadmodule "usrloc.so"
loadmodule "registrar.so"
loadmodule "auth.so"
loadmodule "dialog.so"
loadmodule "uac.so"
loadmodule "nathelper.so"
loadmodule "rtpengine.so"
loadmodule "dispatcher.so"
loadmodule "ndb_redis.so"
loadmodule "http_client.so"
loadmodule "rtimer.so"
loadmodule "topoh.so"
loadmodule "app_lua.so"

modparam("ctl", "binrpc", "unix:/run/kamailio/kamailio_ctl${o.sipPort === 5060 ? '' : '_' + o.sipPort}")
modparam("jsonrpcs", "transport", 1)
modparam("xhttp", "event_callback", "ksr_xhttp_event")

# no reply at all from the next hop within 8 s = dead; the ring time comes from the trunk's dial timeout
modparam("tm", "fr_timer", 8000)
modparam("tm", "fr_inv_timer", 60000)
modparam("tm", "restart_fr_on_each_reply", 0)
modparam("tm", "failure_reply_mode", 3)

modparam("rr", "enable_full_lr", 1)
modparam("rr", "append_fromtag", 1)

modparam("usrloc", "db_mode", 0)
modparam("usrloc", "preload", "location")
modparam("registrar", "default_expires", 300)
modparam("registrar", "min_expires", 60)
modparam("registrar", "max_expires", 3600)
modparam("registrar", "received_avp", "$avp(RECEIVED)")
modparam("nathelper", "received_avp", "$avp(RECEIVED)")
modparam("nathelper", "natping_interval", 0)

modparam("auth", "nonce_expire", 60)
modparam("auth", "qop", "auth")

# one dialog per call: channel limits (profiles), call end events, From/To restore
modparam("dialog", "db_mode", 0)
modparam("dialog", "enable_stats", 1)
modparam("dialog", "default_timeout", 21600)
modparam("dialog", "profiles_with_value", "sdproc;sdtrunk")
modparam("dialog", "track_cseq_updates", 1)
modparam("dialog", "send_bye", 1)
modparam("dialog", "event_callback", "ksr_dialog_event")

modparam("uac", "restore_mode", "auto")
modparam("uac", "restore_dlg", 1)
modparam("uac", "auth_username_avp", "$avp(sdau)")
modparam("uac", "auth_password_avp", "$avp(sdap)")
modparam("uac", "auth_realm_avp", "$avp(sdar)")
modparam("uac", "reg_db_url", "text://${q(o.dir)}/dbtext")
modparam("uac", "reg_contact_addr", "${o.selfIp}:${o.sipPort}")
modparam("uac", "reg_timer_interval", 20)
modparam("uac", "reg_retry_interval", 30)

modparam("rtpengine", "rtpengine_sock", "udp:127.0.0.1:${o.ngPort}")
modparam("rtpengine", "rtpengine_disable_tout", 20)

# OPTIONS ping every 60 s; any SIP answer (not a timeout) means reachable, like Asterisk qualify
modparam("dispatcher", "list_file", "${q(o.dir)}/dispatcher.list")
modparam("dispatcher", "ds_ping_interval", 60)
modparam("dispatcher", "ds_probing_mode", 1)
modparam("dispatcher", "ds_probing_threshold", 1)
modparam("dispatcher", "ds_inactive_threshold", 1)
modparam("dispatcher", "ds_ping_latency_stats", 1)
modparam("dispatcher", "ds_ping_from", "sip:sipdist@${o.selfIp}")
modparam("dispatcher", "ds_ping_reply_codes", "class=2;class=3;class=5;class=6;code=401;code=403;code=404;code=405;code=407;code=480;code=481;code=484;code=486;code=488")

# hide each side from the other: Via, Contact, Record-Route and Call-ID never show the other party's address
modparam("topoh", "mask_key", "${q(o.maskKey || 'sipdist')}")
modparam("topoh", "mask_ip", "${o.advertiseIp || o.selfIp}")
modparam("topoh", "mask_callid", 1)
modparam("topoh", "sanity_checks", 0)

modparam("htable", "htable", "cps=>size=8;autoexpire=5;initval=0;")
modparam("ndb_redis", "server", "${q(redis)}")
modparam("ndb_redis", "init_without_redis", 1)
modparam("ndb_redis", "connect_timeout", 500)
modparam("ndb_redis", "cmd_timeout", 500)
modparam("http_client", "connection_timeout", 1)
modparam("http_client", "keep_connections", 1)

# live call counts per process / trunk -> Redis, every 3 s
modparam("rtimer", "timer", "name=sdsizes;interval=3;mode=1;")
modparam("rtimer", "exec", "timer=sdsizes;route=ksr_rtimer_sizes")

modparam("app_lua", "load", "${q(o.dir)}/sipdist.lua")
cfgengine "lua"
`;
}

// opts: { selfIp, advertiseIp, ngPort, rtpStart, rtpEnd }
function renderRtpengine(o) {
  const addr = o.advertiseIp && o.advertiseIp !== o.selfIp ? `${o.selfIp}!${o.advertiseIp}` : o.selfIp;
  return `${HEADER('#', 'rtpengine: audio relay for Kamailio (userspace forwarding)')}[rtpengine]
table = -1
interface = ${addr}
listen-ng = 127.0.0.1:${o.ngPort}
listen-cli = 127.0.0.1:${o.ngPort + 1}
port-min = ${o.rtpStart}
port-max = ${o.rtpEnd}
timeout = 60
silent-timeout = 3600
tos = 184
num-threads = 16
log-level = 5
`;
}

module.exports = { buildData, renderData, renderDispatcher, renderUacreg, renderDbVersion, renderCfg, renderRtpengine, lua, cidr, hours, codecs };
