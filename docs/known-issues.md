# Known Issues (found 2026-10-07)

Found while checking the live server against the code. Nothing here has been changed yet.

## 1. `SESSION_SECRET` is not set — sessions can be forged (high)

`src/config.js` uses `SESSION_SECRET`, and falls back to `dev-secret-change-me` if it is missing. The live `.env`
has no `SESSION_SECRET` (it has `JWT_SECRET`, which nothing reads), and the running process doesn't have it either.
The fallback value is in the source code, so anyone who can reach port 3000 can sign a valid `sd_session` cookie and
get admin access without a password.

**Fix:** add `SESSION_SECRET=<random 32+ chars>` to `/opt/sipdist/.env`, then `systemctl restart sipdist`
(everyone will have to log in again). Also consider making the app refuse to start without it.

## 2. Live `.env` uses variable names from an older version

| In live `.env` | What the code reads | What happens now |
|---|---|---|
| `HOST`, `PORT` | `HTTP_HOST`, `HTTP_PORT` | defaults `0.0.0.0:3000` (same values, so nothing breaks) |
| `JWT_SECRET` | `SESSION_SECRET` | insecure default — see #1 |
| `ADMIN_USER`, `ADMIN_PASS` | `ADMIN_PASSWORD` (first start only) | ignored |
| `ASTERISK_GEN_DIR` | `ASTERISK_CONF_DIR` | default `/etc/asterisk/sipdist` (same value) |
| `TZ`, `NODE_ENV` | `STATS_TZ` | default `Asia/Kolkata` (same value) |

**Fix:** rename them as shown in [credentials-and-config.md](credentials-and-config.md#environment-variables-optsipdistenv).

## 3. Deleting a trunk that still has processes fails

In the live DB, `processes.trunk_id` has `ON DELETE RESTRICT` (left over from an older schema). `db/schema.sql` expects
`ON DELETE SET NULL`. `DELETE /api/trunks/:id` returns a 500 error if any process still uses the trunk.
**Workaround:** move or delete those processes first. **Fix:** drop and re-create the FK with `ON DELETE SET NULL`,
or show a clear error in the API.

## 4. Old columns and tables left in the database

There are extra legacy columns in `admins`, `trunks`, `processes`, `calls`, `dispositions` and `audit_log`, and also
the empty tables `cdr_legacy_20261006122825` and `daily_stats_legacy_20261006122825`. The full list is in
[database.md](database.md#live-database-vs-schemasql). They don't cause problems but make the schema confusing, so
plan a cleanup migration after taking a backup.

## 5. Dead code in `src/`

`src/index.js`, `app.js`, `state.js`, `live.js`, `ws.js`, `util.js`, `log.js`, `stats.js`, `validate.js` and
`asterisk/manager.js` are ES modules (`import …`) from an older version. `package.json` is `"type": "commonjs"`, and
nothing reachable from `src/server.js` requires them. They refer to columns that don't exist any more (`password_hash`,
`stat_date`, `total_channels`, …). **Fix:** delete them.

## 6. Unrelated files committed to git

`/opt/sipdist` is also the `asterisk` user's working directory, so the initial commit picked up `.bashrc`, `.profile`,
`.bash_logout` and the whole `.npm/_cacache` (≈420 files). **Fix:** `git rm -r --cached .npm .bashrc .profile
.bash_logout` and add them to `.gitignore`.

## 7. Default passwords in `deploy/setup.sh`

`setup.sh` has fallback values for `DB_PASS` and `ARI_PASS` in the repo. If the live install used those defaults,
change them. Either way, always pass your own values when installing.

## 8. Smaller items

- The UI and API on port 3000 use plain HTTP on `0.0.0.0`. Allow only office IPs through the firewall, or put it behind
  an HTTPS reverse proxy.
- Trunk and process SIP passwords are stored in plain text in PostgreSQL (Asterisk needs them in plain text in the
  generated files).
- `cdr_pgsql.so` is not running, so the `cdr` table stays empty. This is fine because the app writes its own `calls`
  table. Configure `/etc/asterisk/cdr_pgsql.conf` only if you want Asterisk's own CDR too.
- `processes.hdr_number`, `hdr_did_name` and `hdr_num_name` are stored but not used: the header names are fixed to
  `X-DID` / `X-Number` in `render.js`. `[sd-cli-<trunk>]` contexts are generated but no longer called.
- Asterisk identifies callers by IP before username (`endpoint_identifier_order=ip,auth_username,username`). A
  password-auth process calling from an IP that an IP-auth process lists is matched to the IP-auth process.
- Password-auth processes receive inbound DID calls only while they are registered to this server.
- The login rate limiter is kept in memory, so it resets when the service restarts.
- Test data: process `tp` has allowed IP `172.0.0.1`. This is a public address, not in the private 172.16/12 range, and
  may be a typo.
