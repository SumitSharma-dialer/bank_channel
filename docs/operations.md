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
| `GET /api/reports/calls?from&to&process&trunk&disposition&direction&did&number&page&size` | call list + totals |
| `GET /api/reports/calls.csv?…` | CSV export (streamed) |
| `GET /api/reports/daily?from&to&scope=process|trunk|did&ref` | daily stats |
| `GET /api/reports/dispositions` | disposition list |
| `GET /api/system/health` | Asterisk version, ARI, DB, Redis, last apply result |
| `POST /api/system/apply` | force re-render + reload |
| `GET /api/system/config-preview` | rendered files |
| `GET /api/system/cli/:what` | read-only `asterisk -rx`: `endpoints`, `registrations`, `contacts`, `groups`, `channels` |
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
| Trunk "Unavailable" | qualify OPTIONS to the carrier fail; `pjsip set logger on` |
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
