# Kamailio — the second SIP engine

The distributor can carry calls on **Asterisk** or on **Kamailio**. Exactly one engine runs at a time: the other is
stopped and disabled at boot. Trunks, processes, DID ranges, reports, the live monitor, dispositions and alerts are
the same on both — only the engine underneath changes. Customers change nothing on their side.

Added on 2026-10-13. The default (and the engine in use until a super admin switches) is Asterisk.

## Switching

**System → SIP engine** shows both engines and the state of their services. Only a **super admin** sees the buttons:

- **Switch to Kamailio / Switch to Asterisk** — stops the engine in use and starts the other one.
- **Restart Kamailio / Restart Asterisk** — restarts the engine in use.

Every live call is dropped by a switch or restart — do it at a quiet time. If the new engine does not start, the old
one is started again and the page shows the reason. The switch is written to the audit and activity logs.

From a root shell (same effect, without the UI): `sipdist-engine kamailio` or `sipdist-engine asterisk`. After a manual
switch also set the engine in the database, or the app keeps talking to the old one:
`UPDATE app_settings SET value='kamailio' WHERE key='sip_engine';` then `systemctl restart sipdist`.

### How the switch works

The app runs as user `asterisk` and cannot start or stop services. It writes `/var/lib/sipdist/engine.request`
(`<engine> <nonce>`); the systemd unit `sipdist-engine.path` sees the change and starts `sipdist-engine.service`,
which runs `/usr/local/sbin/sipdist-engine --request` as root (source: `deploy/sipdist-engine.sh`). The helper:

1. checks `kamailio -c` on the generated config (Kamailio target),
2. copies `rtpengine.conf` to `/etc/rtpengine/` and writes the drop-in `/etc/systemd/system/kamailio.service.d/sipdist.conf`
   (config file, memory, time zone from `STATS_TZ`),
3. `systemctl disable --now` the old engine, `enable` + `restart` the new one,
4. answers in `/var/lib/sipdist/engine.result`; on failure it starts the old engine again.

The engine in use is stored in the table `app_settings` (`sip_engine`).

## Components on Kamailio

| Component | Runs as | Listens on | Purpose |
|---|---|---|---|
| Kamailio 6.0 | `kamailio` | `<server IP>:5060` UDP+TCP (SIP), `127.0.0.1:5065` (JSON-RPC for the app) | SIP: identify, check, limit, route |
| rtpengine | `rtpengine` | RTP UDP `10000-30000` (same range as Asterisk), `127.0.0.1:2223` (control) | Audio relay, codec conversion |

Kamailio is a SIP proxy: it does not handle audio. rtpengine relays the audio of every call (userspace forwarding;
the kernel module is not installed), so carriers and customers keep sending RTP to this server as with Asterisk.

## Files

The app writes everything into `/etc/kamailio/sipdist/` (owner `asterisk`, group `kamailio`, mode 2750):

| File | From | Reload |
|---|---|---|
| `data.lua` | trunks, processes, DID ranges, reject codes (`src/kamailio/render.js`) | RPC `app_lua.reload` — live, no restart |
| `sipdist.lua` | copy of `src/kamailio/sipdist.lua` (the routing logic, static) | RPC `app_lua.reload` |
| `dispatcher.list` | OPTIONS ping targets: trunks (set 1), fixed IPs of IP-auth processes (set 2) | RPC `dispatcher.reload` |
| `dbtext/uacreg` | trunks with "Register" on | RPC `uac.reg_reload` |
| `kamailio.cfg` | modules and settings (server IP, ports, Redis) | engine restart |
| `rtpengine.conf` | server IP, RTP port range | engine restart |

When `kamailio.cfg` or `rtpengine.conf` change (app update, `.env` change) while Kamailio runs, the System page and the
issue list say "restart needed"; trunks, processes and DIDs never need a restart.

`.env` settings (all optional): `KAMAILIO_LISTEN_IP` (default: the server's main IPv4), `KAMAILIO_ADVERTISE_IP` (only
when SIP / RTP must show another address), `KAMAILIO_RPC_PORT` (5065), `RTPENGINE_NG_PORT` (2223), `KAMAILIO_CHILDREN` (16).

## Call flow (sipdist.lua)

Same rules and the same order as the Asterisk dialplan (see [asterisk.md](asterisk.md)):

- **Who is calling** — carrier: source IP = trunk host. Process: source IP (IP auth, CIDR allowed), or digest
  username + password (realm `asterisk`, optional IP lock).
- **Outbound** (process → trunk): dialed number must be the dummy number; `X-DID` / `X-Number` checked; working time;
  process limit, trunk limit, trunk CPS; then the call goes to the trunk with the DID as caller ID
  (`From`, `P-Asserted-Identity`, `Remote-Party-ID`), trunk prefix / strip digits / CLI prefix applied. If the carrier
  asks for a password (401 / 407) the trunk's username + password are sent.
- **Inbound** (carrier → process): DID range → process (`/internal/did-route` first, else the range's owner) →
  the process's fixed IP, or the contact its server registered. Headers `X-DID` / `X-Number` are added.
- **Limits** = Kamailio dialog profiles `sdproc` / `sdtrunk`: join first, then count, like `GROUP()` in Asterisk.
- **Topology hiding** (`topoh`): the carrier never sees a customer's address and the customer never sees the carrier's.

## Call records and the live monitor

`sipdist.lua` pushes one JSON per event to the Redis list `sd:kam:ev`; `src/tracker.js` reads it:

- `start` — the call was sent on: live counters +1, a hit for the process.
- `end` — the call is over. Refused by the distributor (`disp`), answered (`res: answer`), caller gave up (`cancel`),
  rang out (`timeout`), far end silent (`noreply`) or refused by the far end (`fail` + SIP code).

`src/kamailio/events.js` turns the result into the dial status + Q.850 cause Asterisk would report, so dispositions,
the cause rules on the Dispositions page, reports and alerts work unchanged. Events wait in Redis while the app
restarts, so no call record is lost. Every 3 s Kamailio also writes its real call count per process / trunk
(`sd:kam:sizes`); the app overwrites its live counters with it every 10 s.

## What is different from Asterisk

| | Asterisk | Kamailio |
|---|---|---|
| Trunk CPS limit | call waits up to 3 s for a free slot | call is refused at once (TRUNK_LIMIT) |
| Codecs | converts between any installed codecs | rtpengine offers the far end's codec list and converts (ulaw, alaw, g722, g729, gsm, opus) |
| Ring timeout, no answer | 480 to the customer | 480 to the customer |
| Carrier refuses a call | Asterisk picks the SIP code from the hangup cause | the carrier's SIP code is passed to the customer (401 / 407 become 503) |
| Customer registrations | kept across restarts | in memory: customers register again after a Kamailio restart (within their expiry, 5 min) |
| Diagnostics → RTP per channel | from Asterisk | not available; use RTP capture, or System → views → rtp |
| Engine log | `/var/log/asterisk/full` | `journalctl -u kamailio -u rtpengine-daemon` (shown in Diagnostics → Engine log) |
| `npm run originate` (test call) | works | not available — Kamailio cannot place a call itself |

## Checks from a shell

```
systemctl status kamailio rtpengine-daemon
journalctl -u kamailio -f
kamcmd dlg.stats_active            # live calls
kamcmd dispatcher.list             # trunk / customer reachability
kamcmd uac.reg_dump                # trunk registrations
kamcmd ul.dump                     # customers registered with us
node --env-file=.env src/cli/render.js kamailio   # what the app would write
```

## Tested

On 2026-10-13 a private Kamailio + rtpengine on port 5070 was driven with SIPp (fake customer, fake carrier) while
Asterisk stayed live: outbound call, every reject reason, channel limit, carrier busy / no answer / no reply / caller
cancel, carrier password challenge, password customer (right, wrong password, foreign IP), customer REGISTER, trunk
REGISTER, inbound DID to an IP customer and to a registered customer. Not tested: calls with the real carrier and real
customers — the first switch on the live server is that test.
