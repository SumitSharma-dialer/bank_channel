# Users and sessions

The **Users** page (sidebar, admins and super admins) manages who can sign in to the UI and shows every login session.
The **Activity log** page (super admins only) shows what every user did.

## Roles

| Role | Can do |
|---|---|
| **Super admin** | everything, including the Users page and the **Activity log**. Only a super admin can add, change, sign out or delete a super admin or give that role |
| **Admin** | everything except the Activity log. Sees super admins on the Users page read-only; **Sign out all other sessions** leaves super admins signed in |
| **Monitor** (team leader) | read-only. Only the **tabs** and **processes** chosen for the user |

Tabs a monitor user can be given: **Live dashboard**, **CDR report**, **Daily statistics**. All other pages (trunks,
processes, diagnostics, alerts, dispositions, users, system) are admin-only.

For a monitor user the server, not only the menu, limits the data (`src/scope.js`, `src/routes/reports.js`):

- `/api/*`: only `GET` routes behind their tabs (`scope.guard`). Everything else returns `403`, including all writes
  except changing their own password.
- Live dashboard (`GET /api/live` and WebSocket `/ws`): only their processes. Totals are recomputed from those
  processes, the trunk list, trunk names, trunk capacity and the issue badge are removed, and `hit` / `call` events
  for other processes are not sent.
- CDR report and CSV export: `process_code = ANY(<their processes>)`. A process filter outside the list returns nothing.
- Daily statistics and the usage chart: grouped by process only (no trunk / DID view), their processes only.

Rights are re-read at most 30 s after a change. A role change or disabling the user also signs them out at once.

## Sessions

Signing in creates a random 256-bit token in the `sd_session` cookie (HttpOnly, SameSite=Strict). Only its sha256
is stored, in table `sessions`. A session lasts 12 h from sign-in. `last_seen` and the IP are updated at most once a
minute. The Users page lists open sessions (user, IP, browser, signed in, last activity, expiry), or all sessions with
**show ended**. From there an admin can:

- **Sign out** a single session,
- **Sign out** a user, which ends all of that user's sessions,
- **Sign out all other sessions**, meaning every session except the admin's own.

A revoked session stops working on the next request, and its live WebSocket is closed at once (code `4401`, and
the UI goes back to the sign-in page). Sessions also end when:

- the user signs out (`revoked_by` = the user),
- an admin disables the user, changes their role or deletes them,
- a new password is set (by an admin: all sessions; by the user from **Password** in the sidebar: their other sessions).

Ended sessions are deleted by the retention job `RETENTION_DAYS` (5) days after they expire. Sign-in, sign-out and
every user and session change go to the audit log (`login`, `logout`, `user_create`, `user_update`,
`user_password`, `user_delete`, `session_end`, `session_end_all`).

Safety rules: you cannot delete or disable yourself or change your own role, and the last active super admin cannot
be disabled, demoted or deleted. Disabled users cannot sign in. The first user (`admin`, created on an empty database)
is a super admin; when the role was introduced, the existing admins became super admins.

## Activity log (super admins)

Sidebar → **Activity log**. Two tabs, both filtered by day range, user and free text:

- **Activity**: every `/api` request of every user (`activity_log`, written by `src/activity.js`): when, user and role,
  a readable action (`Opened live dashboard`, `Searched CDR report`, `Exported CDR CSV`, `Edited trunk`, …), method,
  path and query, result (HTTP status: refused requests show `403`), duration and IP. Sign-in, sign-out, live feed connects (WebSocket `/ws`), failed
  sign-ins (wrong password / unknown user / disabled user) and blocked sign-ins (too many attempts) are logged too.
  Filters **changes only** (non-GET) and **errors / denied only** (status ≥ 400).
  Not logged: timer refreshes the UI marks with `X-Poll: 1` (System resources, Processes connection status,
  Diagnostics auto-refresh), and repeats of the same GET from the same session within a minute.
- **Changes**: the audit log (`audit_log`) with the saved values. It used to be on the System page; admins no longer
  see it.

Both are kept `RETENTION_DAYS` (5) days.

## API (admin only unless noted)

| Method & path | Purpose |
|---|---|
| `GET /api/users` | users, processes and tabs for the form |
| `POST /api/users` `{username,password,full_name,role,processes,tabs}` | add user (`role`: `superadmin` (super admin only) / `admin` / `viewer`) |
| `PUT /api/users/:id` `{full_name,role,processes,tabs,active}` | edit / enable / disable |
| `POST /api/users/:id/password` `{password}` | set a new password (signs the user out) |
| `DELETE /api/users/:id` | delete user |
| `GET /api/users/sessions[?all=1]` | open sessions (or all, incl. ended) |
| `DELETE /api/users/sessions/:id` | sign out one session |
| `POST /api/users/sessions/end` `{user?}` | sign out every session of `user`, or with no user every other session |
| `POST /api/me/password` `{current,next}` | **any user**: change own password (other own sessions end) |
| `GET /api/activity`, `GET /api/activity/changes` | **super admin only**: activity log and changes, see [operations.md](operations.md) |
