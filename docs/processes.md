# Processes page

A **process** is one customer Asterisk server (or dialer) that sends calls to this box. The Processes page in the UI
creates, edits and monitors them. Every save writes `processes` in PostgreSQL, re-renders
`/etc/asterisk/sipdist/processes.conf` + `dialplan.conf` and reloads Asterisk (see [asterisk.md](asterisk.md)).

Code: `public/app.js` (`procForm`, `loadProcs`, `regChip`), `src/routes/processes.js` (`parse`), `src/asterisk/render.js`
(`renderProcesses`, `peerConfig`), `src/diag/reg.js` (`status`).

## Authentication: by IP or by username + password

Chosen per process with **Authentication** in Add / Edit process (`processes.auth_type`).

| | By server IP (`ip`) | Username + password (`password`) |
|---|---|---|
| How Asterisk recognises the customer | source IP of the INVITE (`[p_<code>-identify] match=`) | SIP digest login (`[p_<code>-auth]`, `identify_by=auth_username,username`) |
| Customer server IPs | **required**; each IP belongs to one process only | optional **IP lock**: if set, the login works only from these IPs (`deny=0.0.0.0/0.0.0.0` + `permit=`); blank = any IP |
| Customer SIP port | where inbound DID calls and the online check are sent (`<first fixed IP>:<port>`) | saved and shown only; calls go to the port the customer **registered** from |
| Customer registers? | no | yes — needed to show **online** and to receive inbound DID calls / callbacks |
| Inbound DID calls go to | first single IP (not a CIDR range) on the port | the registered contact |
| Online check | OPTIONS ping every 60 s | registration |

Asterisk checks IPs **before** usernames (`endpoint_identifier_order=ip,auth_username,username`). So an IP used by an
IP-auth process cannot be used by any other process (the form refuses it). Several username + password processes may
share an IP.

## Add / Edit process fields

| Field | Rules | Stored in |
|---|---|---|
| Process code | 2–32 chars `a-z 0-9 _`; Asterisk endpoint `p_<code>` | `code` |
| Display name | free text | `name` |
| SIP trunk | carrier trunk for outbound calls; none = every call rejected (`NO_ROUTE`) | `trunk_id` |
| Channel limit | max concurrent calls for this customer | `channel_limit` |
| Authentication | By server IP / Username + password | `auth_type` |
| Customer server IPs | comma separated IPs or CIDR ranges (`203.0.113.25, 198.51.100.0/28`). IP auth: required. Password auth: optional IP lock | `allowed_ips` |
| Customer SIP port | 1–65535, default 5060 (both auth types; see the table above for what it does) | `sip_port` |
| SIP username | password auth: 2–64 chars `A-Z a-z 0-9 _ . -`; blank = process code; unique | `sip_username` |
| SIP password | password auth: 8–128 printable chars, no spaces or `; # [ ]`. A random one is filled in; **Generate** makes a new one | `sip_password` (plain text — Asterisk needs it) |
| Outbound / Inbound calls | allow or block each direction, optional working days + hours | `allow_outbound`, `out_hours`, `allow_inbound`, `in_hours` |
| Inbound DIDs | DIDs of the trunk this process receives | `trunk_did_ranges.process_id` |
| Dummy number | 4–20 digits; the customer dials it for every call with headers `X-DID` / `X-Number` | `dummy_cli` |
| Active | inactive = calls rejected (403, `BLOCKED`) | `active` |

On edit, fields the form does not send keep their value (password left as is = keep; `sip_port` not sent = keep).

## Process list

| Column | Shows |
|---|---|
| Process | display name and code |
| Trunk | trunk name; red chip if none or the trunk is off |
| Customer auth | IP auth: IPs + `port N`. Password auth: `user <username>`, the IP lock if any, `port N` |
| **Connection** | 🟢 **online** / 🔴 **offline** (see below) |
| Live / limit | live calls against the channel limit |
| Calls allowed | OUT / IN chips with working hours |
| Dummy number, DIDs assigned, Status | as entered; active / inactive |

Buttons: **Peer config** (config for the customer's server), **Header log** (last 50 calls with the headers received),
**Limit**, **Edit**, **Activate / Deactivate**, **Delete**.

## Connection: online / offline

The column refreshes every 15 s while the page is open (`GET /api/processes/status`). Hover a chip for the details.

| Process | 🟢 online | 🔴 offline | grey |
|---|---|---|---|
| Username + password | registered right now (`database show registrar`). Shows the `ip:port` it registered from; `≠ <port>` if that differs from the process's SIP port | not registered, or the registration expired | — |
| By server IP | at least one fixed IP answers the SIP OPTIONS ping (`pjsip show contacts`, status `Avail`). Shows `ip:port` and round-trip time | no fixed IP answers (`Unavail`) | **checking…** (not pinged yet — up to 60 s after a save or restart), **IP range** (only CIDR ranges: nothing to ping), **inactive** |

How the IP check works: each active IP process gets a monitor-only `[p_<code>-mon]` AOR + endpoint in
`processes.conf` with `qualify_frequency=60`. It is separate from `[p_<code>]` on purpose: Asterisk does not dial a
contact it marked unreachable, so a customer whose firewall drops OPTIONS still gets its inbound calls — it only
shows offline. The monitor endpoint is never identified (`identify_by=ip`, no identify section; a request naming it
gets 401) and has no dialplan.

### Offline — what to check

- **Password auth:** the customer's server must register. The Peer config includes the registration
  (`[sipdist-reg] type=registration` for PJSIP, `register =>` for chan_sip). Wrong username / password → Diagnostics →
  Registrations → **Trace REGISTER** shows the 401 / 403. IP lock set → the customer must register from one of those IPs.
- **IP auth:** the customer must answer SIP OPTIONS on `<ip>:<SIP port>`. Check the port in Edit process, the
  customer's firewall (UDP from `172.20.10.201`), and that their PJSIP has the `[sipdist-identify]` from the Peer config.
  Offline here does not block calls.

## Peer config and password reset

**Peer config** shows a ready PJSIP and chan_sip / ViciDial config for the customer's server: our IP and port, their
username and password (password auth), the dial plan with headers, the inbound context, and — for password auth —
the registration. **Regenerate password** (password auth only, `POST /api/processes/:id/regenerate`) makes a new
password at once; the customer's calls and registration fail until they update their config.
