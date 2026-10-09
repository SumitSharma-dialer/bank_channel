# Architecture

## Components on the live server

| Component | Runs as | Listens on | Purpose |
|---|---|---|---|
| `sipdist.service` (Node.js, `src/server.js`) | user `asterisk` | `0.0.0.0:3000` (HTTP + WebSocket `/ws`) | Web UI, REST API, config renderer, ARI event tracker |
| Asterisk 22.5.2 | user `asterisk` | `0.0.0.0:5060` UDP+TCP (SIP), RTP UDP `10000-30000`, `127.0.0.1:8088` (HTTP/ARI) | Call handling (PJSIP) |
| PostgreSQL 18 | `postgres` | `127.0.0.1:5432` | Config (trunks, processes, DIDs), call records, daily stats, audit log |
| Redis | `redis` | `127.0.0.1:6379`, `[::1]:6379` (password protected) | Live channel counters, peaks, hit counters |

Asterisk also listens on 4569 (IAX2), 4520 (DUNDi) and 5000 because the stock Debian config uses `autoload=yes`
(setup.sh was run in *integrate* mode — see [asterisk.md](asterisk.md)). SIPDist does not use them.

```
 Customer Asterisk servers                      Carrier SIP trunks
 (processes, by IP or user+pass)                (t_<name>)
          │  SIP INVITE to dummy number                ▲
          │  + X-DID / X-Number headers                │ Dial PJSIP/<num>@t_<trunk>
          ▼                                            │
 ┌──────────────────────── Asterisk 22 (PJSIP) ───────────────────────┐
 │  pjsip.conf  ── #tryinclude sipdist/trunks.conf, processes.conf    │
 │  extensions.conf ── #tryinclude sipdist/dialplan.conf              │
 │  ARI (127.0.0.1:8088, user "sipdist")                              │
 └───────▲────────────────────────────┬───────────────────────────────┘
         │ module reload (REST)       │ events WebSocket (ChannelCreated/
         │                            │ ChannelDestroyed/UserEvent SIPDIST_END)
         │      CURL /internal/did-route (inbound routing)
 ┌───────┴────────────────────────────▼───────────────────────────────┐
 │  Node.js  /opt/sipdist  (sipdist.service, port 3000)               │
 │  routes/*  → PostgreSQL → asterisk/render.js → /etc/asterisk/sipdist│
 │  tracker.js → Redis live counters → PostgreSQL calls/daily_stats   │
 └───────▲────────────────────────────────────────────────────────────┘
         │ HTTP + WebSocket /ws (cookie sd_session)
     Browser (admin UI, public/)
```

## Source layout (code actually used)

The running entry point is `src/server.js` (CommonJS). Files used by it:

| File | Role |
|---|---|
| `src/server.js` | Express app, login, route mounting, WebSocket `/ws`, startup (ensure admin → tracker → apply config → listen) |
| `src/config.js` | Reads environment variables (see [credentials-and-config.md](credentials-and-config.md)) |
| `src/db.js` | PostgreSQL pool, `audit()` helper |
| `src/redis.js` | Redis client + Lua commands `sdIncr` / `sdDecr` |
| `src/auth.js` | scrypt password hashing, HMAC-signed session cookie `sd_session` (12 h), first-admin creation |
| `src/ari.js` | Minimal ARI client (REST + reconnecting events WebSocket) |
| `src/tracker.js` | ARI events → Redis counters → `calls` / `daily_stats`; reconcile every 10 s; trunk status poll every 20 s |
| `src/asterisk/render.js` | Pure functions: DB rows → `trunks.conf`, `processes.conf`, `dialplan.conf`, customer-side sample config |
| `src/asterisk/apply.js` | Writes the 3 files atomically, reloads `res_pjsip.so`, `res_pjsip_outbound_registration.so`, `pbx_config.so` via ARI |
| `src/routes/trunks.js` | `/api/trunks` CRUD + DID ranges |
| `src/routes/processes.js` | `/api/processes` CRUD, DID assignment, limits, peer config |
| `src/routes/reports.js` | `/api/reports` calls list, CSV export, daily stats, usage over time |
| `src/routes/system.js` | `/api/system` health, re-apply, config preview, read-only Asterisk CLI, audit log, password change |
| `src/routes/internal.js` | `/internal/did-route` — localhost only, called by the dialplan |
| `src/routes/util.js` | Validation helpers |
| `src/cli/dbinit.js` | `npm run db:init` — runs `db/schema.sql` and creates the first admin |
| `src/cli/render.js` | `npm run render` — prints the generated Asterisk files without writing |
| `public/` | Single-page UI (`index.html`, `app.js`, `style.css`) |
| `deploy/setup.sh`, `deploy/sipdist.service`, `deploy/asterisk/*.conf` | Installer, systemd unit, Asterisk templates |

Files **not** used by the running app (ES-module leftovers from an older version): `src/index.js`, `src/app.js`,
`src/state.js`, `src/live.js`, `src/ws.js`, `src/util.js`, `src/log.js`, `src/stats.js`, `src/validate.js`,
`src/asterisk/manager.js`. See [known-issues.md](known-issues.md).

## How a UI change reaches Asterisk

1. Admin saves a trunk / process in the UI → `POST/PUT /api/trunks|processes`.
2. Route validates input, writes PostgreSQL in a transaction, writes `audit_log`.
3. `tracker.refreshMeta()` reloads the in-memory list of processes/trunks.
4. `apply()` (serialised, one at a time):
   - reads `trunks`, `processes`, `trunk_did_ranges`;
   - renders `trunks.conf`, `processes.conf`, `dialplan.conf`;
   - writes them to `/etc/asterisk/sipdist/` (temp file + rename, mode 0640);
   - calls ARI `PUT /ari/asterisk/modules/res_pjsip.so`, `res_pjsip_outbound_registration.so`, `pbx_config.so`
     (= `module reload`).
5. The API response contains the apply result; the UI shows it as a toast.

The same apply runs on every service start (`apply('startup')`), so Asterisk always matches the DB after a reboot.
**Never edit `/etc/asterisk/sipdist/*.conf` by hand** — it is overwritten on the next save or restart.

## Outbound call flow (customer → carrier)

Generated context `[proc-<code>]` (see `renderDialplan` / `headerCheck` / `dialTail` in `src/asterisk/render.js`):

1. Customer server sends INVITE to `172.20.10.201:5060`. IP auth: PJSIP matches the source IP via `[p_<code>-identify]`
   (`endpoint_identifier_order=ip,...`). Password auth: digest login via `[p_<code>-auth]` (`auth_username`), from any IP
   or only the IP lock's IPs. → endpoint `p_<code>` → context `proc-<code>`. See [processes.md](processes.md).
2. Process inactive or outbound disabled → `BLOCKED` (cause 21 → SIP 403). No active trunk → `NO_ROUTE` (34 → 503).
3. Dialed number must equal the process **dummy number** (`processes.dummy_cli`); anything else → `INVALID` (1 → 404).
4. Read headers `X-DID` and `X-Number`:
   - missing, or `X-Number` not 4–20 digits (optional `+`) → `NO_HEADER` (28 → 484);
   - `X-DID` not inside a caller-ID DID range of the trunk (`[sd-didok-<trunk>]`) → `INVALID_DID` (21 → 403).
5. Outbound working hours (`processes.out_hours`) via `GotoIfTime` in `STATS_TZ` → outside → `OFF_HOURS` (20 → 480).
6. Channel limits with Asterisk groups: `GROUP(sdproc)=<code>` then `GROUP_COUNT > channel_limit` → `CHANNEL_LIMIT`;
   `GROUP(sdtrunk)=<trunk>` then `> max_channels` → `TRUNK_LIMIT` (both cause 34 → 503). Join-then-count means two
   simultaneous calls can never overshoot the limit.
   Then the trunk CPS limit (`trunks.cps`, 0 = off): `GROUP(sdcps)=<trunk>_<EPOCH>` then `GROUP_COUNT > cps` → the
   call waits 100 ms and retries (next second = new group), up to 30 times (3 s), then `TRUNK_LIMIT`. Calls are
   paced, not dropped, during short bursts.
7. Number sent = `trunks.prefix` + `X-Number` with `strip_digits` removed; caller ID = `trunks.cli_prefix` + the DID.
   `Dial(PJSIP/<number>@t_<trunk>, dial_timeout)`.
8. At hangup, handler `[sd-hangup]` sends `UserEvent(SIPDIST_END, ...)`. Node (`tracker.saveCall`) receives it over ARI
   and inserts one row in `calls` and upserts `daily_stats` (scopes `process`, `trunk`, `did`).

## Inbound call flow (carrier → customer)

Generated context `[sd-in-<trunk>]`, used only if the trunk has `allow_inbound = true` **and** DID ranges; otherwise
the trunk uses `[sd-from-trunk]` which rejects everything.

1. Carrier INVITE matched by IP `[t_<trunk>-identify] match=<host>`.
2. Called number is matched against the trunk's DID ranges on its **last N digits** (carrier may add a country code).
   No match → `INVALID`.
3. Process selection:
   1. `CURL http://127.0.0.1:3000/internal/did-route?did=<DID>&from=<caller>` — the process that last called this
      caller from this DID (the query looks back 90 days, but `calls` only keeps 5 days — see [operations.md § Logs and data retention](operations.md#logs-and-data-retention)), else the process that last used this DID as caller ID;
   2. else the process the DID range is assigned to (`trunk_did_ranges.process_id`);
   3. else `NO_ROUTE`.
4. Process inactive / inbound disabled → `BLOCKED`; no fixed IP → `NO_ROUTE`; inbound hours (`in_hours`) → `OFF_HOURS`;
   then the same group-count limits.
5. `Dial(PJSIP/<caller number>@p_<code>)` to the customer's first fixed IP (`[p_<code>]` AOR `contact=sip:<ip>:<sip_port>`, default 5060),
   caller ID = DID, plus headers `X-DID` / `X-Number` added by `[sd-inhdr]`.

## Dispositions

Seeded into table `dispositions` by `db/schema.sql`:

| Code | Meaning | Set by | SIP code |
|---|---|---|---|
| ANSWERED | Answered | trunk | 200 |
| BUSY | Busy | trunk | 486 |
| NO_ANSWER | No answer | trunk | 480 |
| CANCEL | Cancelled by caller | trunk | 487 |
| CONGESTION | Congestion | trunk | 503 |
| FAILED | Failed / unavailable | trunk | 500 |
| CHANNEL_LIMIT | Process limit reached | distributor | 503 |
| TRUNK_LIMIT | Trunk limit reached | distributor | 503 |
| BLOCKED | Process inactive / direction off | distributor | 403 |
| NO_ROUTE | No active trunk / no process | distributor | 503 |
| INVALID | Wrong number / DID not on trunk (inbound) | distributor | 404 |
| OFF_HOURS | Outside working time | distributor | 480 |
| NO_HEADER | X-DID / X-Number missing or bad | distributor | 484 |
| INVALID_DID | X-DID not a caller-ID DID of the trunk | distributor | 403 |
| SIP_DOWN | Trunk / far end unreachable (`CHANUNAVAIL`) | trunk | 503 |

Each code can have a custom display code (CHANNEL_LIMIT is shown as `LIMIT_REACH`), and the SIP response of each
distributor reject can be changed on the Dispositions page — see [diagnostics.md](diagnostics.md#dispositions-page-custom-dispositions).

`DIALSTATUS` values are mapped in `tracker.js` (`ANSWER→ANSWERED`, `NOANSWER→NO_ANSWER`, `CHANUNAVAIL→SIP_DOWN`, …).

## Live monitoring path

- `ChannelCreated` for a channel named `PJSIP/p_<code>-…` or `PJSIP/t_<name>-…` → Redis `HINCRBY` live counter, raise
  today's peak, add a hit (process channels only).
- `ChannelDestroyed` → decrement (never below 0).
- Every 10 s `reconcile()` rebuilds the counters from ARI `GET /channels` (self-healing).
- Every 15 s peaks are copied into `daily_stats.peak_channels`.
- Every 20 s trunk state: ARI `GET /endpoints/PJSIP` + `asterisk -rx "pjsip show registrations"`.
- Every 1 s a snapshot is pushed to logged-in browsers over `/ws`.
