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

Firewall: UDP **10000–30000** (RTP) and UDP/TCP 5060 (SIP) must be open from carriers and customers, and forwarded from the public IP (see [Public IP and NAT](#public-ip-and-nat)). `ufw` is off
on this server; check any firewall in front of it. Check the limits Asterisk really runs with:

```bash
grep 'open files' /proc/$(pidof asterisk)/limits
asterisk -rx 'core show settings' | grep 'open file'
asterisk -rx 'rtp show settings' | grep Port
```

Changing the systemd limits or `maxfiles` needs `systemctl daemon-reload && systemctl restart asterisk`, which drops live
calls. Do it when `asterisk -rx 'core show channels count'` shows 0. `rtp.conf` changes: `asterisk -rx 'module reload res_rtp_asterisk.so'`.

## Public IP and NAT

The server has the private address `172.20.10.201` (LAN `172.20.10.192/27`, gateway `.193`) and reaches the internet as
**`182.95.69.226`** (checked 2026-10-08). Customers and carriers on the internet must use the public address.

| Piece | Setting | Why |
|---|---|---|
| Router / firewall | forward **UDP+TCP 5060** and **UDP 10000–30000** on 182.95.69.226 → 172.20.10.201 | without it nothing from the internet reaches Asterisk: customers cannot register or call (they show **offline**) |
| `.env` | `PUBLIC_IP=182.95.69.226` | the Peer config tells customers to send SIP / register here |
| `pjsip.conf` `[transport-udp]` / `[transport-tcp]` | `external_signaling_address` and `external_media_address=182.95.69.226`, `local_net` = 127/8, 10/8, 172.16/12, 192.168/16 | Asterisk puts the public address in SIP Contact / Via and SDP for internet peers (else they answer to 172.20.10.201 → no registration, no audio); LAN peers (`local_net`) keep the private one |

Changing the transport lines needs `systemctl restart asterisk` (drops calls). Changing `PUBLIC_IP` needs
`systemctl restart sipdist`; customers then need the new Peer config.

Check that internet SIP arrives (open SIP ports get scanner traffic within minutes; replies to our own pings don't
count):

```bash
tcpdump -ni en01 'udp dst port 5060 and not src net 172.20.10.192/27'          # anything from the internet?
tcpdump -ni en01 'host <customer ip>'                                           # a customer's REGISTER / INVITE
```

## Logs and data retention

Asterisk `full` and `messages.log` are kept **3 days**, everything else **5 days** (set up 2026-10-08):

| What | Where | Kept | How |
|---|---|---|---|
| Asterisk CLI log (what `asterisk -rvvv` shows: NOTICE / WARNING / ERROR / VERBOSE 3 / DTMF) | `/var/log/asterisk/full` | 3 days | `logger.conf`: `full => notice,warning,error,verbose(3),dtmf`; `/etc/logrotate.d/asterisk` ← `deploy/logrotate-asterisk`: daily, `rotate 3`, `maxage 3`, gzip (`full.2.gz` …), then `asterisk -rx 'logger reload'` |
| Asterisk warnings / errors | `/var/log/asterisk/messages.log` | 3 days | same logrotate rule (`queue_log` and other `*_log`: 5 days) |
| App log (`[http]`, `[ari]`, `[apply]`, `[retention]` …) and the rest of the system journal | journald (`journalctl -u sipdist`) | 5 days | `/etc/systemd/journald.conf.d/sipdist-retention.conf` ← `deploy/journald-retention.conf`: `MaxRetentionSec=5day` |
| Call history | `calls`, `cdr` | 5 days | `src/retention.js`, 1 min after start then every 6 h, batches of 5000 rows; `RETENTION_DAYS` in `.env` changes it |
| CPU / RAM / storage history (System → Resource history graphs) | `sys_metrics` | 5 days | `src/sysinfo.js`: one row per minute, rows older than 5 days deleted every hour (not `RETENTION_DAYS`) |
| Audit log, Diagnostics issues (closed), alert log | `audit_log`, `diag_issues` (`closed_at`), `alert_log` | 5 days | same job; open issues are kept however old |
| Reports | `daily_stats` | **kept** (not deleted) | one row per process / trunk / DID per day — Reports still show older days |

Not changed: OS logs from rsyslog (`/var/log/syslog`, `auth.log` …) keep Ubuntu's weekly × 4.

Effects of 5 days of `calls`:
- Reports → call list / Call lookup only find the last 5 days (totals per day stay in `daily_stats`).
- Inbound DID routing to "the process that last called this caller" only knows the last 5 days; older callbacks go to
  the DID's assigned process.

Where to read the CLI log: **System → Asterisk CLI log** (live, follows every 3 s, filter by text) and
**Diagnostics → Asterisk log** (search the last 32 MB by text / level, click a `[C-xxxxxxxx]` call id for all its
lines). Shell: `tail -f /var/log/asterisk/full`, older days `zgrep <text> /var/log/asterisk/full.*.gz`.

Disk: verbose logging writes roughly 1–2 KB per call. At the planned ~2,000 concurrent calls of a dialer that is a
few GB per day, so 5 days fits easily on `/` (78 GB free); watch **System → Server resources → Storage /**.

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
sudo PUBLIC_IP=182.95.69.226 DB_PASS=… ARI_PASS=… bash deploy/setup.sh               # integrate mode (default)
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
| `GET /api/processes/status` | `{registered: {code: [{ip, port, userAgent, expiresIn}]}, reachable: {code: [{ip, port, status, rtt}]}}`. `registered`: password processes registered right now (`database show registrar`; missing = not registered). `reachable`: OPTIONS ping per fixed IP of IP processes (`pjsip show contacts`, `p_<code>-mon`; status `Avail` / `Unavail` / `NonQual` = not pinged yet). Feeds the Connection column on the Processes page: online (registered / answers the ping) or offline; refreshed every 15 s |
| `GET /api/reports/calls?from&to&process&trunk&disposition&direction&did&number&page&size` | call list + totals |
| `GET /api/reports/calls.csv?…` | CSV export (streamed) |
| `GET /api/reports/daily?from&to&scope=process|trunk|did&ref` | daily stats |
| `GET /api/reports/dispositions` | disposition list |
| `GET /api/system/health` | Asterisk version, ARI, DB, Redis, last apply result |
| `GET /api/system/resources` | CPU % (two `/proc/stat` samples 0.4 s apart; idle + iowait = idle), load average, cores, Asterisk's share of all CPU; RAM used / total / available (`MemAvailable`) and swap; storage per real disk mount (ext4/xfs/…, no tmpfs/snap) used / total / free. Feeds the **Server resources** tiles on the System page (refreshed every 5 s; meter amber ≥ 80 %, red ≥ 95 %). Code `src/sysinfo.js` |
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
