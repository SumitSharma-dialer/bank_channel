# Operations

## Service

```bash
systemctl status sipdist
systemctl restart sipdist          # also re-renders + reloads Asterisk config on start
journalctl -u sipdist -f           # app log ([http], [ari], [apply], [track], [auth])
systemctl status asterisk postgresql redis-server
```

Unit `/etc/systemd/system/sipdist.service`: user/group `asterisk`, `WorkingDirectory=/opt/sipdist`,
`ExecStart=node --env-file=/opt/sipdist/.env src/server.js`, `Restart=always`, `LimitNOFILE=65536`,
`ProtectSystem=full`, write access only to `/etc/asterisk/sipdist`. Starts after postgresql, redis, asterisk.

Startup order in `src/server.js`: create first admin if none → start ARI tracker → apply config to Asterisk → listen
on port 3000.

## Capacity and tuning

How many calls at the same time this server can carry (one call = customer leg + carrier leg, both through Asterisk
because `direct_media=no`; G.711 `ulaw`/`alaw` passthrough, no transcoding). The lowest line is the real limit:

| Limit | Ceiling | Why |
|---|---|---|
| Open files (Asterisk) | ~170,000 calls | `LimitNOFILE` / `maxfiles` = 1,048,576; ~6 per call (RTP + RTCP per leg, SIP) |
| RTP ports | **5,000 calls** | `rtp.conf` 10000–30000 = 10,000 RTP ports (RTCP uses the odd one) ÷ 2 legs |
| Network (1 Gbit/s `en01`) | **~4,500 calls** | G.711 at 20 ms = 50 packets/s, ~95 kbit/s per direction on the wire; each call sends 2 and receives 2 streams = ~190 kbit/s each way. 1 Gbit/s × ~85 % usable |
| Asterisk / CPU (48 × Xeon E5-2651 v2 @ 1.8 GHz) | **~2,000–3,000 calls (estimate, not load-tested)** | Asterisk relays every RTP packet in user space: 3,000 calls = 600,000 packets/s through one Asterisk process. Older 1.8 GHz cores; per-call channel threads and locks, not total cores, set the limit |

**Plan for ~2,000 concurrent calls; up to ~3,000 after a load test.** Above that: a second server, or a 10 Gbit/s link plus
a media relay (rtpengine) so Asterisk does not handle RTP itself. Call setup rate (calls per second) also matters
for dialers: load-test it too.

Load test before selling more channels (sum of all process channel limits ≤ the tested number): run SIPp with RTP
(`sipp -sf uac_pcap.xml …`) from another machine against a test process and trunk, raise the call count step by step,
and watch `top -H -p $(pidof asterisk)`, `asterisk -rx 'core show channels count'`, and Diagnostics → RTP / audio for
packet loss and jitter. Stop at the first step with loss > 1 % or a core of Asterisk at 100 %.

Tuning in place (2026-10-08, files in `deploy/`, installed by `setup.sh`):

| Setting | Value | File |
|---|---|---|
| Asterisk open files | `LimitNOFILE=1048576` (was soft 1024 ≈ 200 calls) | `/etc/systemd/system/asterisk.service.d/sipdist-limits.conf` ← `deploy/asterisk-limits.conf` |
| Asterisk threads / processes | `LimitNPROC=infinity`, `TasksMax=infinity` | same |
| Asterisk `maxfiles` | 1048576 | `/etc/asterisk/asterisk.conf` `[options]` |
| RTP ports | 10000–30000 (was 10000–20000) | `/etc/asterisk/rtp.conf`; app setting `RTP_START`/`RTP_END` (default 10000/30000) must match |
| UDP buffers | `rmem_max`/`wmem_max` 16 MB, `rmem_default`/`wmem_default` 1 MB | `/etc/sysctl.d/90-sipdist.conf` ← `deploy/sysctl-sipdist.conf` |
| Kernel backlog | `netdev_max_backlog=10000` | same |
| Ephemeral ports | 32768–60999 (kept above the RTP range) | same |

Firewall: UDP **10000–30000** (RTP) and UDP/TCP 5060 (SIP) must be open from carriers and customers. `ufw` is off
on this server; check any firewall in front of it. Check the limits Asterisk really runs with:

```bash
grep 'open files' /proc/$(pidof asterisk)/limits
asterisk -rx 'core show settings' | grep 'open file'
asterisk -rx 'rtp show settings' | grep Port
```

Changing the systemd limits or `maxfiles` needs `systemctl daemon-reload && systemctl restart asterisk`, which drops live
calls. Do it when `asterisk -rx 'core show channels count'` shows 0. `rtp.conf` changes: `asterisk -rx 'module reload res_rtp_asterisk.so'`.

## npm scripts (run from `/opt/sipdist`, as `asterisk`)

| Command | What it does |
|---|---|
| `npm start` | run the server in the foreground |
| `npm run dev` | run with `--watch` |
| `npm test` | unit tests for the config renderer (`test/render.test.js`) |
| `npm run db:init` | apply `db/schema.sql` (idempotent) + create first admin |
| `npm run render` | print the Asterisk files that would be generated (no write) |

## Installing / upgrading

```bash
sudo PUBLIC_IP=172.20.10.201 DB_PASS=… ARI_PASS=… bash deploy/setup.sh               # integrate mode (default)
sudo PUBLIC_IP=… EXTERNAL_IP=<NAT ip> ASTERISK_MODE=full bash deploy/setup.sh       # replace Asterisk config
```

setup.sh: installs Node 24 / PostgreSQL if missing, creates DB role + database, binds Redis to loopback, backs up and
edits Asterisk config, copies the app to `/opt/sipdist`, `npm install`, creates `.env` **only if missing**, runs
`dbinit.js`, installs and starts the systemd unit. Safe to re-run.

## HTTP API

All `/api/*` routes except login need the `sd_session` cookie (HttpOnly, SameSite=Strict, 12 h).
Login is rate-limited to 10 failures per IP per 15 minutes.

| Method & path | Purpose |
|---|---|
| `POST /api/login` `{username,password}` / `POST /api/logout` / `GET /api/me` | session |
| `GET /api/live` | live snapshot (also pushed every 1 s on WebSocket `/ws`, plus `hit` and `call` events) |
| `GET/POST /api/trunks`, `PUT/DELETE /api/trunks/:id`, `POST /api/trunks/:id/active` | trunks + `did_ranges` |
| `GET/POST /api/processes`, `PUT/DELETE /api/processes/:id` | processes + `dids` |
| `POST /api/processes/:id/limit` `{channel_limit}` | change limit only |
| `POST /api/processes/:id/active` `{active}` | enable/disable |
| `POST /api/processes/:id/regenerate` | new SIP password (password-auth processes) |
| `GET /api/processes/:id/peer-config` | customer-side PJSIP / chan_sip sample |
| `GET /api/processes/:id/header-log` | last 50 header calls (is the customer sending X-DID / X-Number?) |
| `GET /api/processes/suggest` | random dummy number + password |
| `GET /api/processes/registrations` | `{code: [{ip, port, userAgent, expiresIn}]}` for processes registered right now (`database show registrar`); missing code = not registered. Feeds the Registration column on the Processes page (refreshed every 15 s) |
| `GET /api/reports/calls?from&to&process&trunk&disposition&direction&did&number&page&size` | call list + totals |
| `GET /api/reports/calls.csv?…` | CSV export (streamed) |
| `GET /api/reports/daily?from&to&scope=process|trunk|did&ref` | daily stats |
| `GET /api/reports/dispositions` | disposition list |
| `GET /api/system/health` | Asterisk version, ARI, DB, Redis, last apply result |
| `POST /api/system/apply` | force re-render + reload |
| `GET /api/system/config-preview` | rendered files |
| `GET /api/system/cli/:what` | read-only `asterisk -rx`: `endpoints`, `registrations`, `contacts`, `groups`, `channels`, `channelstats`, `transports`, `qualify`, `rtp` |
| `GET /api/dispositions`, `PUT /api/dispositions/:code` `{custom_code,label,sip_code}` | custom dispositions (re-applies the dialplan when `sip_code` changes) |
| `GET /api/diag/status` | tools found (tcpdump/tshark/sngrep), trace state, RTP range |
| `GET /api/diag/alerts`, `POST /api/diag/alerts/test` `{channel: slack\|email}` | alert configuration (no secrets), recent alerts, send a test |
| `GET /api/diag/registrations` | registration state per trunk / process (no passwords returned) |
| `GET /api/diag/sip/messages?after&types&q` | live SIP messages since id `after` |
| `GET /api/diag/issues`, `POST /api/diag/issues/run` | open issues + history; run checks now |
| `POST /api/diag/sip/start` `{minutes,target,host,keepNoise}`, `POST /api/diag/sip/stop`, `POST /api/diag/sip/clear` | live SIP trace |
| `GET /api/diag/sip/dialogs?q&method`, `GET /api/diag/sip/dialog?id`, `GET /api/diag/sip/dialog.pcap?id` | trace results, one call flow, one call as pcap |
| `GET /api/diag/target?target&host` | resolve `trunk:<name>` / `process:<code>` / `ip` (+`host`) to the IPs that will be captured |
| `GET /api/diag/pcap?tool=tcpdump\|sngrep&seconds&target&host&port&match&sip&rtp` | capture download (tcpdump streamed; sngrep keeps dialogs matching `match`) |
| `POST /api/diag/rtp/capture` `{seconds,target,host}`, `GET /api/diag/rtp/channels` | RTP stream analysis; live per-channel RTP counters |
| `GET /api/diag/log?q&levels&lines` | Asterisk log search |
| `GET /api/system/audit?limit=` | audit log |
| `POST /api/system/password` `{current,next}` | change own password (min 8 chars) |
| `GET /internal/did-route?did&from` | **localhost only**, no login — used by inbound dialplan CURL |

Every create/update/delete writes `audit_log` and triggers an Asterisk apply; the response includes `apply`
(`ok`, `error`, `reloaded`).

## Troubleshooting

| Symptom | Check |
|---|---|
| UI shows "ARI disconnected" | `asterisk -rx 'ari show users'`, `ARI_USER/ARI_PASS` vs `ari.conf`, `http.conf` enabled on 127.0.0.1:8088, `journalctl -u sipdist` for `[ari]` |
| Save works but Asterisk not updated | toast/`/api/system/health` → `apply.error`; `ls -l /etc/asterisk/sipdist`; `asterisk -rx 'pjsip show endpoints'` |
| Customer calls rejected with 403 | process inactive / outbound off (`BLOCKED`) or `INVALID_DID`; check `calls.disposition`, `hdr_status` |
| 484 | `NO_HEADER` — customer not sending `X-DID` / `X-Number`; use header log |
| 404 | customer dialed something other than the dummy number (`INVALID`) |
| 503 | `CHANNEL_LIMIT`, `TRUNK_LIMIT` or `NO_ROUTE`; `asterisk -rx 'group show channels'` |
| 480 | `OFF_HOURS` (working hours in `STATS_TZ`) or carrier no-answer |
| Calls not appearing in reports | `[sd-hangup]` UserEvent → ARI must be connected; `journalctl -u sipdist | grep saveCall` |
| Customer call not identified (401/no endpoint) | source IP not in `allowed_ips`; `asterisk -rx 'pjsip show identifies'` |
| Live counters look wrong | they self-heal every 10 s from ARI; Redis can be flushed safely (`sd:*` keys) |
| Trunk "Unavailable" / `SIP_DOWN` calls | qualify OPTIONS to the carrier fail; Diagnostics → SIP trace with "include OPTIONS" ticked, filtered on the carrier IP |
| No audio / one-way audio | Diagnostics → RTP / audio: "no RTP received" on a channel, or a one-way stream in the capture; check NAT / `rtp_symmetric` / firewall on UDP 10000-30000 |
| SIP trace says "Operation not permitted" | the unit is missing `AmbientCapabilities=CAP_NET_RAW` — see [diagnostics.md](diagnostics.md#permissions-tcpdump-needs-cap_net_raw) |
| Deleting a trunk gives a server error | live FK is `ON DELETE RESTRICT` — move/delete its processes first |

## Backup

What to back up:
- PostgreSQL database `sipdist` (all configuration + call history):
  `sudo -u postgres pg_dump -Fc sipdist > sipdist-$(date +%F).dump`
- `/opt/sipdist/.env` (secrets — store securely, not in git)
- `/etc/asterisk/` (base Asterisk config; `sipdist/` is regenerated from the DB)
- `/etc/redis/sipdist.conf`

Redis does not need a backup (live counters only).

Restore: restore the DB, put back `.env`, `systemctl restart sipdist` — the generated Asterisk files are rewritten on start.
