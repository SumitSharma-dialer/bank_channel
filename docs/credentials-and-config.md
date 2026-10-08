# Credentials and Configuration

> This document lists **where** each secret lives and what it must match. It intentionally contains **no secret
> values**. Never commit `/opt/sipdist/.env` (it is in `.gitignore`).

## Credential map

| Credential | Stored in | Read by | Must match | How to change |
|---|---|---|---|---|
| PostgreSQL app user (`DB_USER` / `DB_PASS`, live: user `sipdist`, db `sipdist`) | `/opt/sipdist/.env` | `src/config.js` → `src/db.js` | PostgreSQL role password (`ALTER ROLE`) | `sudo -u postgres psql -c "ALTER ROLE sipdist PASSWORD '…'"`, update `.env`, `systemctl restart sipdist` |
| Redis password (`REDIS_PASS`) | `/opt/sipdist/.env` | `src/config.js` → `src/redis.js` (builds `redis://:<pass>@host:port/0`; `REDIS_URL` overrides) | `requirepass` in `/etc/redis/sipdist.conf` (included from `/etc/redis/redis.conf` line ~2349) | change both, `systemctl restart redis-server sipdist` |
| ARI user (`ARI_USER` / `ARI_PASS`, live user `sipdist`) | `/opt/sipdist/.env` | `src/config.js` → `src/ari.js` (HTTP Basic auth) | `/etc/asterisk/ari.conf` section `[sipdist]`, `password=` (plain) | edit both, `asterisk -rx 'module reload res_ari.so'`, restart sipdist |
| Web UI admin password | table `admins.pass_hash` (scrypt hash) | `src/auth.js` | — | UI → System → change password (`POST /api/system/password`) |
| Initial admin password | env `ADMIN_PASSWORD` (only on **first** start when `admins` is empty; otherwise random and printed once to the journal) | `auth.ensureAdmin()` | — | only relevant for a fresh DB |
| Session cookie signing key | env `SESSION_SECRET` | `src/auth.js` (HMAC-SHA256 of `sd_session`) | — | add to `.env`, restart (logs everyone out). **Missing on live — see [known-issues.md](known-issues.md)** |
| Carrier trunk SIP login | `trunks.username` / `trunks.password` (plain text in DB) | `renderTrunks()` | carrier account | UI → Trunks (blank password on edit = keep) |
| ↳ written to | `/etc/asterisk/sipdist/trunks.conf` `[t_<name>-auth]` (mode 0640) | Asterisk | | regenerated automatically |
| Customer authentication | `processes.auth_type`: `ip` → `processes.allowed_ips`; `password` → `sip_username` / `sip_password` | `renderProcesses()` → `[p_<code>-identify] match=` (ip) or `[p_<code>-auth]` (password) | customer server public IP, or the customer's `outbound_auth` | UI → Processes → Authentication (see [processes.md](processes.md)) |
| Customer SIP username / password (password auth) | `processes.sip_username` / `sip_password` (plain) | `[p_<code>-auth]` in `processes.conf` | customer's `outbound_auth` + registration (Peer config shows it) | UI → Processes → Edit, or Peer config → Regenerate password (`POST /api/processes/:id/regenerate`) |
| Asterisk CDR DB login (full mode only) | `/etc/asterisk/cdr_pgsql.conf` | `cdr_pgsql.so` | DB role | not configured on live |

File permissions on live:
- `/opt/sipdist/.env` — `600 asterisk:asterisk`
- `/etc/asterisk/ari.conf` — `640 asterisk:asterisk`
- `/etc/asterisk/sipdist/` — `2750`, files `640`
- PostgreSQL only on `127.0.0.1`, `scram-sha-256`; Redis on loopback with password; ARI on `127.0.0.1:8088`.

`deploy/setup.sh` contains **default** DB and ARI passwords that are used if you don't pass `DB_PASS` / `ARI_PASS`.
They are committed in the repo — always pass your own values when installing.

## Environment variables (`/opt/sipdist/.env`)

Loaded by Node with `--env-file=/opt/sipdist/.env` (see `deploy/sipdist.service`). `src/config.js` reads:

| Variable | Default in `config.js` | Used for | Set in live `.env`? |
|---|---|---|---|
| `HTTP_HOST` | `0.0.0.0` | UI/API bind address | no (live uses `HOST`, which is ignored — default applies) |
| `HTTP_PORT` | `3000` | UI/API port; also used in the dialplan CURL URL | no (live uses `PORT`, ignored — default applies) |
| `SESSION_SECRET` | `dev-secret-change-me` | cookie signing | **no** (live has `JWT_SECRET`, which is ignored) |
| `ADMIN_PASSWORD` | random | first admin only | no (live has `ADMIN_PASS`, ignored) |
| `PUBLIC_IP` | `127.0.0.1` | shown in UI + customer peer config | yes (`172.20.10.201`) |
| `SIP_PORT` | `5060` | customer peer config | no (default) |
| `ARI_URL` | `http://127.0.0.1:8088` | ARI | yes |
| `ARI_USER` / `ARI_PASS` | `channel_ari` / empty | ARI login | yes |
| `ARI_APP` | `sipdist` | ARI events app name | yes |
| `ASTERISK_CONF_DIR` | `/etc/asterisk/sipdist` | where generated files go | no (live has `ASTERISK_GEN_DIR`, ignored — default matches) |
| `ASTERISK_RELOAD` | on (`0` = write files only) | ARI module reload after write | no |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASS` | `127.0.0.1` / `5432` / `channel_bank` / `channel_bank` / empty | PostgreSQL | yes |
| `REDIS_URL` or `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASS` | `127.0.0.1:6379` db 0 | Redis | yes (host/port/pass) |
| `STATS_TZ` | `Asia/Kolkata` | day boundaries, working-hours checks, reports | no (default) |
| `PJSIP_TRANSPORT_UDP` / `PJSIP_TRANSPORT_TCP` | empty | adds `transport=` lines (read in `render.js`) | no |

Live `.env` also contains `NODE_ENV`, `HOST`, `PORT`, `TZ`, `JWT_SECRET`, `ADMIN_USER`, `ADMIN_PASS`,
`ASTERISK_GEN_DIR` — written for an older version of the app and **not read** by the current code.

A correct `.env` for the current code (values replaced by placeholders):

```ini
HTTP_HOST=0.0.0.0
HTTP_PORT=3000
SESSION_SECRET=<random 32+ chars>
PUBLIC_IP=172.20.10.201
SIP_PORT=5060
ARI_URL=http://127.0.0.1:8088
ARI_USER=sipdist
ARI_PASS=<same as ari.conf [sipdist] password>
ARI_APP=sipdist
ASTERISK_CONF_DIR=/etc/asterisk/sipdist
ASTERISK_RELOAD=1
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=sipdist
DB_USER=sipdist
DB_PASS=<postgres role password>
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASS=<same as requirepass in /etc/redis/sipdist.conf>
STATS_TZ=Asia/Kolkata
```

## Other configuration locations

| What | Where |
|---|---|
| systemd unit | `/etc/systemd/system/sipdist.service` (copy of `deploy/sipdist.service`) |
| PostgreSQL | `/etc/postgresql/18/main/postgresql.conf`, `pg_hba.conf`; data `/var/lib/postgresql/18/main` |
| Redis | `/etc/redis/redis.conf` (bind 127.0.0.1 ::1, port 6379) + `/etc/redis/sipdist.conf` (password) |
| Asterisk | `/etc/asterisk/` — see [asterisk.md](asterisk.md) |
| App code | `/opt/sipdist` (also the git working copy) |
