# Diagnostics & Dispositions

Two UI pages for finding SIP and call problems: **Diagnostics** (`#/diag`) and **Dispositions** (`#/dispositions`).

## Diagnostics page

| Tab | What it does | Backend |
|---|---|---|
| **Issues** | Open problems and their history. Checks run every 30 s; an issue opens when a check fails and closes when it passes again. The nav badge shows the open count (red = critical). | `src/diag/issues.js`, table `diag_issues` |
| **SIP trace → Live messages** | Every SIP request and response as it happens (INVITE, 100, 180, 183, 200, ACK, BYE, CANCEL, REGISTER, 401, OPTIONS…), newest at the bottom, updated every second. Filter by type (calls / REGISTER / OPTIONS / other) and text; tick "full text" to see each whole message like `tcpdump -A`; click a row to expand it, click the Call-ID to open that call's flow. Last 5000 messages kept. | `MessageLog` in `src/diag/sip.js`, `GET /api/diag/sip/messages?after&types&q` |
| **SIP trace → Calls** | Like `sngrep`: start a trace (1–60 min, optional IP filter), see every SIP dialog (INVITE, …) with its state (CALL SETUP / RINGING / IN CALL / COMPLETED / REJECTED / CANCELLED), click one for the ladder diagram and the full SIP messages, and download that call as `.pcap`. OPTIONS / REGISTER are skipped unless ticked. | `tcpdump` → `src/diag/pcap.js` → `src/diag/sip.js` (in memory, last 2000 dialogs, 60 messages each) |
| **RTP / audio** | (1) Asterisk's own RTP counters for every live channel (ARI `GET /channels/{id}/rtp_statistics`): packets, loss, jitter, RTT, with "no RTP received" (no / one-way audio) flags. (2) Capture RTP for 5–60 s and analyse each stream like `tshark -z rtp,streams`: codec, packets, lost, sequence errors, max gap, jitter, one-way detection. | `src/routes/diag.js`, `src/diag/rtp.js` |
| **Packet capture** | Download a `.pcap` of SIP and/or RTP for 10–300 s. Tool: **tcpdump** (every packet, optional extra port) or **sngrep** (only SIP dialogs matching a number / DID / Call-ID). Open in Wireshark → Telephony → VoIP Calls. Also lists the CLI commands for `sngrep`, `tcpdump`, `tshark` over SSH, including one per trunk. | `src/diag/capture.js` |
| **Asterisk log** | Search the end (last 8 MB) of `/var/log/asterisk/messages.log` by text and level. Click a `[C-xxxxxxxx]` call id to see every line of that call. | `GET /api/diag/log` |
| **Call lookup** | Enter a number / DID / Call-ID: CDR rows with what the disposition means and the Q.850 hangup cause, matching SIP dialogs from the trace buffer, and matching log lines. | combines the APIs above |

### Trunk / process filter

SIP trace, RTP capture and Packet capture have a **Trunk / process** picker (`target`): all traffic, one trunk, one
process, or a custom IP / CIDR. The server turns it into IPs (`GET /api/diag/target`, shown under the picker):

- trunk → its `host` (DNS names are resolved);
- process → its `allowed_ips` (IPs and CIDRs); password-auth processes → the IP they registered from
  (`pjsip show contacts`); neither → error, use a custom IP.

### Issue checks

| Key | Severity | Opens when |
|---|---|---|
| `ari_down` | critical | ARI events WebSocket disconnected |
| `apply_failed` | critical | last config apply to Asterisk failed |
| `redis_down` | critical | Redis ping fails |
| `sip_down:<trunk>` | critical | active trunk endpoint `offline` / `unavailable` (qualify gets no reply) |
| `reg:<trunk>` | critical | trunk registration not `Registered` |
| `trunk_full:<trunk>`, `proc_full:<code>` | warning | ≥ 90 % of channel limit in use |
| `limit:<code>` | warning | any `CHANNEL_LIMIT` (LIMIT_REACH) rejects in the last 15 min |
| `badreq:<code>` | warning | ≥ 5 `NO_HEADER` / `INVALID_DID` / `INVALID` in 15 min (customer dialplan wrong) |
| `sipdown_calls:<trunk>` | critical | any `SIP_DOWN` calls in 15 min |
| `tlimit:<trunk>` | warning | any `TRUNK_LIMIT` rejects in 15 min |
| `failrate:<trunk>` | critical | ≥ 50 % of ≥ 10 trunk calls `CONGESTION` / `FAILED` / `SIP_DOWN` in 15 min |
| `lowasr:<trunk>` | warning | < 5 % answered of ≥ 30 trunk calls in 15 min |

Opening/closing is logged to the journal as `[issue] OPEN …` / `[issue] CLOSED …`.

### Permissions: tcpdump needs CAP_NET_RAW

The service runs as `asterisk`. `deploy/sipdist.service` grants raw-socket capture with
`AmbientCapabilities=CAP_NET_RAW` (works together with `NoNewPrivileges=true`). Without it the SIP trace / pcap / RTP
capture show "Operation not permitted — the service needs CAP_NET_RAW". Live RTP counters, log search, issues and
call lookup do not need it.

Captures only accept validated filters (IP / CIDR, port, SIP / RTP toggles), never a free-text BPF expression. At most
3 tcpdump processes run at once; downloads stop after the chosen time or 200 MB. Every trace / download is written to
`audit_log` (`sip_trace`, `pcap`).

sngrep runs headless (`sngrep -N -q -F -d any -O <tmpfile> <match> <bpf>`; `-r` adds RTP) into a temp dir under
`/tmp` that is removed after the download.

Settings (`.env`, optional): `SNGREP_BIN`, `ASTERISK_LOG` (default `/var/log/asterisk/messages.log`), `RTP_START` / `RTP_END`
(default 10000 / 20000, must match `rtp.conf`), `TCPDUMP_BIN`.

## Dispositions page (custom dispositions)

Every disposition can be given its own **display code** (`dispositions.custom_code`, A–Z 0–9 _, max 16) and label.
The display code is used in the CDR page, live feed, stats, issue titles and the CSV column `disposition_code`
(the CSV `disposition` column keeps the internal code, so old reports and filters keep working). On upgrade,
`CHANNEL_LIMIT` is shown as **`LIMIT_REACH`**.

For distributor rejects (`CHANNEL_LIMIT`, `TRUNK_LIMIT`, `BLOCKED`, `NO_ROUTE`, `INVALID`, `OFF_HOURS`, `NO_HEADER`,
`INVALID_DID`) the **SIP response the customer receives** can be changed (403, 404, 408, 480, 484, 486, 488, 500, 502,
503). Saving re-renders the dialplan: `render.js` turns the SIP code into the Q.850 cause for `Hangup()` and
chan_pjsip turns it back into that SIP response. Example: set `CHANNEL_LIMIT` to 486 if the customer dialer should
treat "limit reached" as busy and retry later.

### SIP_DOWN

New disposition. `Dial()` returning `CHANUNAVAIL` (the trunk — or, for inbound calls, the customer server — cannot be
reached: qualify says unreachable / no contact) is now stored as `SIP_DOWN` instead of `FAILED`, counted in
`daily_stats.sip_down` and shown in its own "SIP down" column on the Daily statistics page.
