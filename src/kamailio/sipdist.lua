-- SIP Channel Distributor: call routing for Kamailio (KEMI, Lua 5.1).
-- Does what the generated Asterisk dialplan does (src/asterisk/render.js): identify the process / trunk, check the
-- X-DID / X-Number headers, working time and channel limits, send the call on, and report every call to the web app.
-- This file is static. Trunks, processes and DID ranges come from data.lua, which the app rewrites on every change
-- and then reloads with the RPC command app_lua.reload (no restart, no dropped calls).

local DIR = (debug.getinfo(1, "S").source:match("^@(.*)/[^/]*$")) or "/etc/kamailio/sipdist"
local D = dofile(DIR .. "/data.lua")

local REASON = { [403] = "Forbidden", [404] = "Not Found", [408] = "Request Timeout", [480] = "Temporarily Unavailable",
  [484] = "Address Incomplete", [486] = "Busy Here", [488] = "Not Acceptable Here", [500] = "Server Internal Error",
  [502] = "Bad Gateway", [503] = "Service Unavailable" }
local RTP = "replace-origin replace-session-connection ICE=remove RTP/AVP"
-- never passed on: the distributor's own headers, credentials, and identity headers it sets itself
local STRIP = { "X-DID", "X-Number", "P-Asserted-Identity", "P-Preferred-Identity", "Remote-Party-ID" }

local function pv(name)
  local v = KSR.pv.gete(name)
  if v == nil then return "" end
  return tostring(v)
end
local function digits(s) return (s:gsub("[^0-9]", "")) end

-- ---------------------------------------------------------------- events -> Redis list -> web app (src/tracker.js)
local function jstr(s)
  return '"' .. (tostring(s):gsub('[%c"\\]', function(ch)
    if ch == '"' then return '\\"' elseif ch == "\\" then return "\\\\" end
    return " "
  end)) .. '"'
end
local function json(t)
  local a = {}
  for k, v in pairs(t) do
    if type(v) == "number" then a[#a + 1] = jstr(k) .. ":" .. string.format("%d", v)
    elseif v ~= nil and v ~= "" then a[#a + 1] = jstr(k) .. ":" .. jstr(v) end
  end
  return "{" .. table.concat(a, ",") .. "}"
end
local function push(s)
  if KSR.ndb_redis.redis_cmd_p1("sd", "RPUSH " .. D.ev_key .. " %s", s, "r") < 0 then
    KSR.err("sipdist: call event lost, Redis not reachable: " .. s .. "\n")
  end
  KSR.ndb_redis.redis_free("r")
end
-- base = event JSON saved with the call (without the closing brace), extra = what is known at the end
local function finish(base, extra)
  if base == "" then return end
  extra["end"] = os.time()
  push(base .. "," .. json(extra):sub(2))
end

-- ---------------------------------------------------------------- who is calling
local function ip2n(ip)
  local a, b, c, d = ip:match("^(%d+)%.(%d+)%.(%d+)%.(%d+)$")
  if not a then return nil end
  return ((a * 256 + b) * 256 + c) * 256 + d
end
local function in_cidrs(list, ip)
  local n = ip2n(ip)
  if not n then return nil end
  for _, c in ipairs(list) do
    if math.floor(n / c[2]) == c[1] then return c end
  end
  return nil
end
local function proc_by_ip(ip)
  local code = D.ip2proc[ip]
  if not code then
    local c = in_cidrs(D.cidr2proc, ip)
    code = c and c[3]
  end
  return code and D.procs[code]
end
local function identify(ip)
  local p = proc_by_ip(ip)
  if p then return p end
  -- password processes on a shared / unknown IP: by the user name they authenticate with, or From: p_<code>
  local au, fu = pv("$au"), pv("$fU")
  local code = D.user2proc[au] or (fu:sub(1, 2) == "p_" and D.procs[fu:sub(3)] and fu:sub(3)) or D.user2proc[fu]
  p = code and D.procs[code]
  if p and p.auth == "password" then return p end
  return nil
end
local function challenge() KSR.auth.www_challenge(D.realm, 1) end
-- password processes: optional IP lock, then digest authentication. true = go on, false = a reply was sent
local function authenticate(p, ip, method)
  if p.auth == "ip" then return true end
  if p.locked and not p.ips[ip] and not in_cidrs(p.cidrs, ip) then
    KSR.sl.sl_send_reply(403, "Forbidden")
    return false
  end
  if pv("$au") ~= p.user or KSR.auth.pv_www_authenticate(D.realm, p.pass, 0, method) < 0 then
    challenge()
    return false
  end
  KSR.auth.consume_credentials()
  return true
end

-- ---------------------------------------------------------------- checks
local function open_now(h)
  if not h then return true end
  local d = os.date("*t")   -- local time of the kamailio service (TZ = STATS_TZ, set by deploy/sipdist-engine.sh)
  if not h.days[tostring(d.wday)] then return false end
  local m = d.hour * 60 + d.min
  if h.from <= h.to then return m >= h.from and m <= h.to end
  return m >= h.from or m <= h.to
end
-- ranges hold digit strings of one length, so string order is numeric order
local function range_of(list, did, tail)
  for _, r in ipairs(list) do
    local d = did
    if tail and #d > r.len then d = d:sub(-r.len) end
    if #d == r.len and d >= r.first and d <= r.last then return r, d end
  end
  return nil
end
local function profile_size(profile, value)
  KSR.dialog.get_profile_size(profile, value, "$var(sdn)")
  return tonumber(KSR.pv.get("$var(sdn)")) or 0
end
local function has_sdp() return KSR.textops.has_body_type("application/sdp") > 0 end
-- the far end may only be offered these codecs; rtpengine converts when the caller has none of them
local function offer_flags(codecs)
  if not codecs or #codecs == 0 then return RTP end
  local f = RTP .. " codec-mask-all codec-except-telephone-event"
  for _, c in ipairs(codecs) do f = f .. " codec-transcode-" .. c end
  return f
end

-- ---------------------------------------------------------------- send the call on
-- c = call event so far, o = { ruri, du, cli, from_user, from_dom, to, codecs, timeout, pai, hdrs, user, pass }
local function relay(c, o)
  KSR.pv.sets("$ru", o.ruri)
  if o.du then KSR.pv.sets("$du", o.du) end
  for _, h in ipairs(STRIP) do KSR.hdr.remove(h) end
  KSR.uac.uac_replace_from('"' .. o.cli .. '"', "sip:" .. o.from_user .. "@" .. o.from_dom)
  KSR.uac.uac_replace_to("", o.to)
  if o.pai then
    local id = '"' .. o.cli .. '" <sip:' .. o.cli .. "@" .. o.from_dom .. ">"
    KSR.hdr.append("P-Asserted-Identity: " .. id .. "\r\n")
    KSR.hdr.append("Remote-Party-ID: " .. id .. ";party=calling;privacy=off;screen=no\r\n")
  end
  for _, h in ipairs(o.hdrs or {}) do KSR.hdr.append(h .. "\r\n") end
  if o.user then
    KSR.pv.sets("$avp(sdau)", o.user)
    KSR.pv.sets("$avp(sdap)", o.pass)
  end
  KSR.rr.record_route()
  KSR.nathelper.set_contact_alias()
  if has_sdp() then KSR.rtpengine.rtpengine_manage(offer_flags(o.codecs)) end

  local base = json(c):sub(1, -2)
  KSR.pv.sets("$avp(sdev)", base)
  KSR.pv.sets("$dlg_var(sdev)", base)
  KSR.tm.t_set_fr(o.timeout * 1000, 8000)
  KSR.tm.t_on_reply("ksr_onreply_call")
  KSR.tm.t_on_failure("ksr_failure_call")
  push(json({ e = "start", id = c.id, proc = c.proc, trunk = c.trunk, dir = c.dir, num = c.num, at = c.start }))
  if KSR.tm.t_relay() < 0 then
    finish(base, { res = "noreply", live = 1 })
    KSR.sl.send_reply(503, REASON[503])
  end
end

-- refuse the call with the SIP code set on the Dispositions page, and record it
local function reject(c, disp)
  local code = D.reject[disp] or 503
  c.disp, c.sip = disp, code
  c["end"] = os.time()
  push(json(c))
  KSR.sl.send_reply(code, REASON[code] or "Rejected")
end

-- one dialog per call; join the profiles first, then count: two calls arriving together can never both pass
local function limits(c, p, t)
  KSR.tm.t_newtran()
  KSR.dialog.dlg_manage()
  KSR.dialog.set_dlg_profile("sdproc", p.code)
  KSR.dialog.set_dlg_profile("sdtrunk", t.name)
  if profile_size("sdproc", p.code) > p.limit then reject(c, "CHANNEL_LIMIT") return false end
  if t.max > 0 and profile_size("sdtrunk", t.name) > t.max then reject(c, "TRUNK_LIMIT") return false end
  return true
end

-- process -> trunk. The customer dials its dummy number; X-DID = caller ID (a caller-ID DID of the trunk),
-- X-Number = the number to call.
local function call_out(p, ip)
  local c = { e = "end", id = pv("$ci"), dir = "out", proc = p.code, trunk = p.trunk_name or "", num = pv("$rU"),
    cli = pv("$fU"), src = ip, start = os.time() }
  if not p.active or not p.out then return reject(c, "BLOCKED") end
  local t = p.trunk and D.trunks[p.trunk]
  if not t then return reject(c, "NO_ROUTE") end
  if not p.dummy or c.num ~= p.dummy then return reject(c, "INVALID") end

  local hd, hn = pv("$hdr(X-DID)"), pv("$hdr(X-Number)")
  c.hdid = (hd:gsub("[^0-9a-zA-Z+.]", "")):sub(1, 40)
  c.hnum = (hn:gsub("[^0-9a-zA-Z+.]", "")):sub(1, 40)
  local did, num = digits(hd):sub(-10), digits(hn)
  c.hst = "missing"
  if hd == "" or hn == "" then return reject(c, "NO_HEADER") end
  c.hst = "bad_number"
  if hn:find("[^0-9+]") or #num < 4 or #num > 20 then return reject(c, "NO_HEADER") end
  num = num:sub(-10)
  c.hst = "bad_did"
  if hd:find("[^0-9+]") or not range_of(t.cli_ranges, did, false) then return reject(c, "INVALID_DID") end
  c.hst, c.num, c.did = "ok", num, did

  if not open_now(p.out_hours) then return reject(c, "OFF_HOURS") end
  if not limits(c, p, t) then return end
  if t.cps > 0 and KSR.htable.sht_inc("cps", t.name .. ":" .. c.start) > t.cps then return reject(c, "TRUNK_LIMIT") end

  local out, cli = t.prefix .. num:sub(t.strip + 1), t.cli_prefix .. did
  local dom = t.from_domain or D.self_ip
  local dest = "sip:" .. out .. "@" .. t.host .. ":" .. t.port
  c.out, c.cliout = out, cli
  relay(c, { ruri = dest .. (t.tcp and ";transport=tcp" or ""), cli = cli, from_user = t.from_user or cli, from_dom = dom,
    to = dest, codecs = t.codecs, timeout = t.timeout, pai = true, user = t.user, pass = t.pass })
end

-- carrier -> process: the dialed DID picks the process (the app knows who last used it, else the range's owner).
-- The process gets: dialed number = the caller's number, caller ID = the DID, plus X-DID / X-Number.
local function call_in(t, ip)
  local num = pv("$rU")
  if #t.in_ranges == 0 or not num:find("^[+0-9].") then
    KSR.sl.sl_send_reply(#t.in_ranges == 0 and 403 or 404, #t.in_ranges == 0 and "Forbidden" or "Not Found")
    return
  end
  local c = { e = "end", id = pv("$ci"), dir = "in", trunk = t.name, num = num, cli = pv("$fU"), src = ip, start = os.time() }
  local r, did = range_of(t.in_ranges, digits(num), true)
  if not r then return reject(c, "INVALID") end
  local cust = digits(c.cli)
  c.did = did

  local code = ""
  if D.route_url ~= "" then
    if KSR.http_client.query(D.route_url .. "?did=" .. did .. "&from=" .. cust, "$var(sdroute)") == 200 then
      code = (pv("$var(sdroute)"):gsub("[^a-z0-9_]", ""))
    end
  end
  if code == "" then code = r.proc or "" end
  local p = D.procs[code]
  if not p then return reject(c, "NO_ROUTE") end
  c.proc = p.code
  if not p.active or not p.inb then return reject(c, "BLOCKED") end
  if p.auth == "ip" and not p.dst then return reject(c, "NO_ROUTE") end
  if not open_now(p.in_hours) then return reject(c, "OFF_HOURS") end
  if not limits(c, p, t) then return end

  local out = cust ~= "" and cust or did
  c.out, c.cliout = out, did
  local ruri, du
  if p.dst then
    ruri = "sip:" .. out .. "@" .. p.dst:sub(5)
  else
    -- password process: the contact its server registered
    if KSR.registrar.lookup_uri("location", "sip:p_" .. p.code .. "@" .. D.self_ip) < 0 then
      c.res, c.live = "noreply", 0
      c["end"] = os.time()
      push(json(c))
      KSR.sl.send_reply(503, REASON[503])
      return
    end
    KSR.pv.sets("$rU", out)
    ruri, du = pv("$ru"), pv("$du")
  end
  relay(c, { ruri = ruri, du = du ~= "" and du or nil, cli = did, from_user = did, from_dom = D.self_ip,
    to = "sip:" .. out .. "@" .. D.self_ip, codecs = p.codecs, timeout = t.timeout,
    hdrs = { "X-DID: " .. did, "X-Number: " .. cust } })
end

local function register(ip)
  local p = identify(ip)
  if not p then return challenge() end
  if p.auth == "ip" then KSR.sl.sl_send_reply(403, "Forbidden") return end
  if not authenticate(p, ip, "REGISTER") then return end
  KSR.nathelper.fix_nated_register()
  -- one contact per process, a new registration replaces the old one
  if KSR.registrar.save_uri("location", 4, "sip:p_" .. p.code .. "@" .. D.self_ip) < 0 then KSR.sl.sl_reply_error() end
end

-- requests inside a call: BYE, ACK, re-INVITE (hold), UPDATE
local function within_dialog(m)
  if KSR.rr.loose_route() > 0 then
    if m ~= "ACK" and KSR.dialog.is_known_dlg() < 0 then
      KSR.sl.sl_send_reply(481, "Call Does Not Exist")
      return
    end
    KSR.nathelper.handle_ruri_alias()
    if m == "BYE" then
      KSR.rtpengine.rtpengine_manage(RTP)
    elseif m == "INVITE" or m == "UPDATE" or m == "ACK" then
      if has_sdp() then KSR.rtpengine.rtpengine_manage(RTP) end
      if m ~= "ACK" then
        KSR.nathelper.set_contact_alias()
        KSR.tm.t_on_reply("ksr_onreply_indlg")
      end
    end
    KSR.tm.t_relay()
    return
  end
  if m == "ACK" then
    -- ACK of a failed call (no route set): belongs to the transaction
    if KSR.tm.t_check_trans() > 0 then KSR.tm.t_relay() end
    return
  end
  KSR.sl.sl_send_reply(404, "Not here")
end

-- ---------------------------------------------------------------- Kamailio entry points
function ksr_request_route()
  if KSR.maxfwd.process_maxfwd(10) < 0 then
    KSR.sl.sl_send_reply(483, "Too Many Hops")
    return 1
  end
  local m = pv("$rm")
  if m == "CANCEL" then
    if KSR.tm.t_check_trans() > 0 then KSR.tm.t_relay() end
    return 1
  end
  if m ~= "ACK" then
    if KSR.tmx.t_precheck_trans() > 0 then
      KSR.tm.t_check_trans()   -- retransmission: answered from the transaction
      return 1
    end
    if KSR.tm.t_check_trans() == 0 then return 1 end
  end
  if KSR.siputils.has_totag() > 0 then
    within_dialog(m)
    return 1
  end

  local ip = pv("$si")
  local tn = D.ip2trunk[ip]
  if m == "OPTIONS" then
    if tn or proc_by_ip(ip) then KSR.sl.sl_send_reply(200, "OK") end   -- strangers get no answer
    return 1
  end
  if m == "REGISTER" then
    register(ip)
    return 1
  end
  if m ~= "INVITE" then
    KSR.sl.sl_send_reply(405, "Method Not Allowed")
    return 1
  end
  if tn then
    call_in(D.trunks[tn], ip)
    return 1
  end
  local p = identify(ip)
  if not p then
    challenge()
    return 1
  end
  if authenticate(p, ip, "INVITE") then call_out(p, ip) end
  return 1
end

function ksr_onreply_call()
  local code = tonumber(pv("$rs")) or 0
  if code == 180 or code == 183 then KSR.pv.seti("$avp(sdring)", 1) end
  if code >= 180 and code < 300 then
    KSR.nathelper.set_contact_alias()
    if has_sdp() then KSR.rtpengine.rtpengine_manage(RTP) end
  end
  return 1
end

function ksr_onreply_indlg()
  local code = tonumber(pv("$rs")) or 0
  if code >= 180 and code < 300 then
    KSR.nathelper.set_contact_alias()
    if has_sdp() then KSR.rtpengine.rtpengine_manage(RTP) end
  end
  return 1
end

-- the call was not answered: caller gave up, the far end refused, or nobody replied
function ksr_failure_call()
  local base, ring = pv("$avp(sdev)"), pv("$avp(sdring)") == "1" and 1 or 0
  local code = tonumber(pv("$T_reply_code")) or 0
  if KSR.tm.t_is_canceled() > 0 then
    finish(base, { res = "cancel", ring = ring, live = 1 })
    KSR.rtpengine.rtpengine_manage(RTP)
    return 1
  end
  -- the carrier asks for the trunk's username / password: answer once
  if (code == 401 or code == 407) and pv("$avp(sdau)") ~= "" and pv("$avp(sdtry)") == "" then
    KSR.pv.seti("$avp(sdtry)", 1)
    local h = pv("$T_rpl($hdr(Proxy-Authenticate))")
    if h == "" then h = pv("$T_rpl($hdr(WWW-Authenticate))") end
    KSR.pv.sets("$avp(sdar)", h:match('realm="([^"]*)"') or "")
    if KSR.uac.uac_auth() > 0 then
      KSR.tm.t_on_reply("ksr_onreply_call")
      KSR.tm.t_on_failure("ksr_failure_call")
      if KSR.tm.t_relay() > 0 then return 1 end
    end
  end
  local res, rc = "fail", nil
  if KSR.tm.t_branch_timeout() > 0 then
    -- rang until the dial timeout -> 480 like Asterisk; no reply at all -> the far end is down
    if KSR.tm.t_branch_replied() > 0 then res, rc = "timeout", 480 else res, rc = "noreply", 503 end
  elseif code == 401 or code == 407 then
    rc = 503   -- never hand the carrier's password request to the customer
  end
  finish(base, { res = res, sip = code, ring = ring, live = 1 })
  KSR.rtpengine.rtpengine_manage(RTP)
  if rc then KSR.tm.t_reply(rc, REASON[rc]) end
  return 1
end

-- an answered call ended (BYE from either side, or the dialog timed out)
function ksr_dialog_event(evname)
  if evname == "dialog:end" then
    finish(pv("$dlg_var(sdev)"), { res = "answer", ans = tonumber(pv("$dlg(start_ts)")) or 0, live = 1 })
  end
  return 1
end

-- every 3 s: live calls per process / trunk -> Redis, so the app's counters can never drift
function ksr_rtimer_sizes()
  local p, t = {}, {}
  for code in pairs(D.procs) do p[#p + 1] = jstr(code) .. ":" .. profile_size("sdproc", code) end
  for name in pairs(D.trunks) do t[#t + 1] = jstr(name) .. ":" .. profile_size("sdtrunk", name) end
  local s = '{"at":' .. os.time() .. ',"proc":{' .. table.concat(p, ",") .. '},"trunk":{' .. table.concat(t, ",") .. "}}"
  KSR.ndb_redis.redis_cmd_p1("sd", "SET " .. D.sizes_key .. " %s EX 15", s, "r")
  KSR.ndb_redis.redis_free("r")
  return 1
end

-- JSON-RPC for the web app (127.0.0.1 only): reload, status views
function ksr_xhttp_event(evname)
  if pv("$hdr(X-SD-Key)") ~= D.rpc_key then
    KSR.xhttp.xhttp_reply(403, "Forbidden", "text/plain", "forbidden\n")
    return 1
  end
  KSR.jsonrpcs.dispatch()
  return 1
end
