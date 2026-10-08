# Database

- Engine: PostgreSQL 18.6, `127.0.0.1:5432`, auth `scram-sha-256` for TCP (`/etc/postgresql/18/main/pg_hba.conf`).
- Live database / owner role: **`sipdist` / `sipdist`** (from `/opt/sipdist/.env`). Note: `db/schema.sql`, `config.js`
  and `setup.sh` default to `channel_bank`; the live install overrides it.
- Schema source: `db/schema.sql` — idempotent, safe to re-run (`npm run db:init`). It creates missing tables/columns,
  relaxes leftover NOT NULL columns, and renames tables whose primary key is incompatible to `<name>_legacy_<timestamp>`.
- **Retention: 5 days** (`RETENTION_DAYS`). `src/retention.js` deletes older rows of `calls`, `cdr`, `audit_log`,
  `alert_log` and closed `diag_issues` every 6 h. `daily_stats` is kept (Reports). See
  [operations.md § Logs and data retention](operations.md#logs-and-data-retention).

## Entity relations

```
trunks 1 ──< processes            (processes.trunk_id)
trunks 1 ──< trunk_did_ranges     (ON DELETE CASCADE)
processes 1 ──< trunk_did_ranges  (process_id, ON DELETE SET NULL; NULL = DID not assigned)
dispositions 1 ──< calls          (calls.disposition)
calls ── process_code / trunk_name are copied as text so history survives renames/deletes
daily_stats (day, scope, ref)     ref = process code | trunk name | DID
```

## Tables (as defined by `db/schema.sql`)

### `admins` — UI logins
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| username | varchar(64) unique | first user is `admin` |
| pass_hash | text | `scrypt$<salt hex>$<hash hex>` (`src/auth.js`) |
| created_at | timestamptz | |

### `trunks` — carrier SIP trunks → `/etc/asterisk/sipdist/trunks.conf`
| Column | Type | Default | Notes |
|---|---|---|---|
| id | serial PK | | |
| name | varchar(32) unique | | `^[a-z0-9_]{2,32}$`; Asterisk endpoint = `t_<name>` |
| description | text | | |
| host | varchar(255) | | carrier IP/hostname; used for AOR contact **and** IP identify |
| port | int | 5060 | |
| transport | varchar(8) | udp | `udp` / `tcp` |
| username, password | varchar(128) | | **plain text**; if both set → `[t_<name>-auth]` section |
| register | bool | true | outbound registration (only if username+password) |
| from_user, from_domain | varchar | | optional From header overrides |
| max_channels | int | 30 | trunk limit, 0 = unlimited |
| prefix | varchar(32) | '' | prepended to the number sent |
| strip_digits | int | 0 | digits removed from the front (0–10) |
| codecs | varchar(128) | ulaw,alaw | |
| dial_timeout | int | 60 | seconds (5–300) |
| allow_inbound | bool | true | accept carrier calls to the trunk's DIDs |
| active | bool | true | inactive trunks are not written to Asterisk |
| created_at, updated_at | timestamptz | | |

### `processes` — customer Asterisk servers → `processes.conf` + `[proc-<code>]` in `dialplan.conf`
| Column | Type | Default | Notes |
|---|---|---|---|
| id | serial PK | | |
| code | varchar(32) unique | | endpoint `p_<code>`, context `proc-<code>` |
| name | varchar(128) | | display name |
| trunk_id | int → trunks.id | | outgoing trunk |
| channel_limit | int | 10 | max concurrent calls (≥1) |
| auth_type | varchar(10) | password | `ip` (identified by `allowed_ips`) or `password` (identified by `sip_username`, customer registers). Chosen per process in the UI; the API defaults to `ip` when not sent |
| sip_username, sip_password | varchar | | only for `password` auth (plain text). Username: 2–64 chars `A-Za-z0-9_.-`, defaults to `code`, unique. Password: 8–128 printable chars, no spaces or `; # [ ]`. `NULL` for `ip` auth |
| allowed_ips | text | '' | comma separated IPs/CIDRs. `ip` auth (required): → `[p_<code>-identify] match=`; first fixed IP = inbound destination; each IP belongs to one process. `password` auth (optional): → `deny=0.0.0.0/0.0.0.0` + `permit=` on the endpoint, so the username works only from these IPs; blank = any IP |
| sip_port | int | 5060 | `ip` auth: SIP port of the customer server (1–65535). Used for `[p_<code>]` AOR `contact=sip:<first fixed IP>:<sip_port>` (inbound DID calls) and the `[p_<code>-mon]` OPTIONS ping. `password` auth: saved and shown for reference only — calls go to the port the customer registered from; the Processes page Connection chip marks a registration from another port (`≠ <sip_port>`). Kept on edit when not sent |
| cli_mode | varchar(12) | dummy | `dummy` / `passthrough` / `trunk_did`; API saves `dummy` (caller ID always from `X-DID`) |
| dummy_cli | varchar(32) | '' | the "dummy number" the customer must dial (4–20 digits) |
| codecs | varchar(128) | ulaw,alaw | |
| active | bool | true | |
| notes | text | | |
| allow_outbound / allow_inbound | bool | true | per direction on/off |
| out_hours / in_hours | jsonb | NULL | NULL = any time, else `{"days":["mon",…],"from":"09:00","to":"18:00"}` in `STATS_TZ` |
| hdr_number, hdr_did_name, hdr_num_name | varchar | '', X-DID, X-Number | stored, but the renderer currently uses fixed header names `X-DID` / `X-Number` |
| created_at, updated_at | timestamptz | | |

### `trunk_did_ranges` — DIDs owned on a trunk
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| trunk_id | int → trunks.id, cascade | |
| first_did, last_did | varchar(15) | 4–15 digits, same length, first ≤ last (single DID: first = last) |
| process_id | int → processes.id, set null | inbound owner; NULL = free / not assigned |
| use_as_cli | bool, default true | part of the allowed caller-ID pool (checked against `X-DID`) |
| note | varchar(128) | |

Ranges may not overlap within or across trunks (checked in `routes/trunks.js`). Assigning DIDs to a process splits and
re-merges ranges (`assignDids` in `routes/processes.js`).

### `calls` — own CDR, one row per customer/inbound call (written from `SIPDIST_END`)
| Column | Notes |
|---|---|
| id bigserial PK, uniqueid (unique) | Asterisk UNIQUEID — duplicate events ignored |
| linkedid | |
| direction | `out` / `in` |
| process_id, process_code, trunk_id, trunk_name | |
| src_ip | customer/carrier source address |
| cli_in | caller ID received |
| cli_out | caller ID sent |
| dialed | number received (outbound: value of `X-Number`) |
| sent_number | number sent to the trunk (after prefix/strip) |
| did | DID used as caller ID (out) or DID called (in) |
| hdr_status | `ok` / `missing` / `bad_number` / `bad_did` / `none`; NULL for inbound |
| hdr_did, hdr_num | raw header values (filtered, max 40 chars) |
| disposition → dispositions.code | see [architecture.md](architecture.md#dispositions) |
| dialstatus, hangup_cause | Asterisk values |
| start_time, answer_time, end_time | timestamptz |
| ring_sec, bill_sec, duration | seconds |

Indexes: BRIN on `start_time`; `(process_code, start_time)`, `(trunk_name, start_time)`, `(disposition, start_time)`,
`dialed`, partial `(did, start_time) WHERE did IS NOT NULL`, partial `(process_code, start_time) WHERE hdr_status IS NOT NULL`.

### `daily_stats` — per-day counters, PK `(day, scope, ref)`
`scope` = `process` | `trunk` | `did`; `ref` = process code / trunk name / DID.
Counters: `total, answered, busy, no_answer, cancel, congestion, failed, channel_limit, trunk_limit, blocked, no_route,
invalid, off_hours, no_header, invalid_did, sip_down, talk_sec, peak_channels`. Updated on every call end; `peak_channels`
copied from Redis every 15 s. Calls rejected before reaching the trunk are not counted on the trunk.

### `dispositions` — lookup (code PK, label, source `trunk|distributor`, sip_code, sort, custom_code)
Seeded on every schema run; only `source` and `sort` are refreshed for existing rows, because `label`, `sip_code`
(distributor rows: the SIP response sent to the customer) and `custom_code` (display code, `''` = the code) are edited
on the Dispositions page. See [diagnostics.md](diagnostics.md#dispositions-page-custom-dispositions).

### `diag_issues` — issue tracker
`id, key, severity (critical|warning), title, detail, hint, opened_at, last_seen, closed_at`. Open while
`closed_at IS NULL` (unique per `key` among open rows). Written by `src/diag/issues.js` every 30 s.

### `audit_log` — who changed what
`id, at, admin, action (create/update/delete/limit/activate/deactivate/apply/login/password/…), entity, entity_id, details jsonb`.

### `cdr` — Asterisk's own CDR table for `cdr_pgsql`
Standard Asterisk columns (`calldate, clid, src, dst, dcontext, channel, dstchannel, lastapp, lastdata, duration,
billsec, disposition, amaflags, accountcode, uniqueid, userfield, peeraccount, linkedid, sequence`).
**Currently empty on the live server:** `cdr_pgsql.so` is "Not Running" and `/etc/asterisk/cdr_pgsql.conf` is the
stock file (integrate mode does not configure it). The app does not need it — `calls` is the real CDR.

## Live database vs `schema.sql`

The live DB was first created by an older version and then upgraded in place, so it has **extra legacy columns** that
the current code ignores:

| Table | Legacy columns still present |
|---|---|
| admins | `password_hash`, `last_login` (username is varchar(50)) |
| trunks | `code` (unique), `total_channels`, `dial_prefix`, `notes` |
| processes | `auth_mode`, `dummy_number` |
| calls | `call_date`, `trunk_code`, `caller_id`, `dialed_number`, `dial_status`, `talk_sec`, `total_sec`, `started_at`, `answered_at`, `ended_at` + old indexes `idx_calls_*` |
| dispositions | `description`, `sort_order` |
| audit_log | `admin_user`, `created_at` + index `idx_audit_created` (`entity_id` is integer, not varchar) |

Other live differences:
- `processes.trunk_id` FK is **`ON DELETE RESTRICT`** (schema.sql says `SET NULL`) → deleting a trunk that still has
  processes fails with a server error. Move/delete the processes first.
- Duplicate unique indexes exist (e.g. `admins_username_key` + `admins_username_uidx`) — harmless.
- Leftover tables from the 2026-10-06 upgrade: `cdr_legacy_20261006122825`, `daily_stats_legacy_20261006122825`
  (both empty, can be dropped).

Live data at time of writing: 1 admin, 1 trunk (`test`, 172.16.3.12), 1 process (`tp`), 5 DID ranges, 14 dispositions.

## Redis key layout (`src/redis.js`, `src/tracker.js`)

| Key | Type | Content | TTL |
|---|---|---|---|
| `sd:live:proc` | hash | process code → live channels | — (rebuilt every 10 s) |
| `sd:live:trunk` | hash | trunk name → live channels | — |
| `sd:live:all` | hash | `all` → total live customer channels | — |
| `sd:peak:proc:<YYYY-MM-DD>` | hash | process code → today's peak; field `__all` = whole box | 3 days |
| `sd:peak:trunk:<YYYY-MM-DD>` | hash | trunk name → today's peak | 3 days |
| `sd:hits:<code>:<10s bucket>` | int | new calls in a 10 s bucket | 1 h |
| `sd:hitsday:<YYYY-MM-DD>` | hash | process code → calls today | 3 days |
| `sd:ch:<channelId>` | string | `p:<code>` or `t:<name>` — which counter the channel holds | 24 h |

Redis holds only live/derived data; losing it is safe (counters are rebuilt from ARI within 10 s).

## Useful queries

```sql
-- today's calls per process and disposition (IST)
SELECT process_code, disposition, count(*), sum(bill_sec)
FROM calls WHERE start_time >= (now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata'
GROUP BY 1,2 ORDER BY 1,3 DESC;

-- which process owns / uses which DID
SELECT t.name trunk, r.first_did, r.last_did, p.code owner, r.use_as_cli
FROM trunk_did_ranges r JOIN trunks t ON t.id=r.trunk_id LEFT JOIN processes p ON p.id=r.process_id ORDER BY 1,2;

-- header problems from a customer
SELECT start_time, hdr_status, hdr_did, hdr_num, disposition FROM calls
WHERE process_code='tp' AND hdr_status <> 'ok' ORDER BY start_time DESC LIMIT 50;
```
