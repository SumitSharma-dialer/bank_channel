# SIP Channel Distributor — System Documentation

These documents describe the system as it runs on the live server (checked on 2026-10-07):
host `172.20.10.201`, app in `/opt/sipdist`, Asterisk 22.5.2 (Debian package), PostgreSQL 18.6, Redis, Node.js.

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | Components, ports, how a call flows (outbound and inbound), how a UI change reaches Asterisk |
| [database.md](database.md) | Every table and column, relations, indexes, Redis key layout, differences between `schema.sql` and the live DB |
| [asterisk.md](asterisk.md) | Which Asterisk files exist, which ones the app writes, which ones setup.sh edited, the generated dialplan logic, reload flow |
| [credentials-and-config.md](credentials-and-config.md) | Where every password / secret / setting is stored, which file reads it and what it must match |
| [operations.md](operations.md) | Service management, logs, HTTP API, CLI tools, troubleshooting, backup |
| [known-issues.md](known-issues.md) | Problems found while writing these docs (config mismatches, dead code, schema drift) |

## One-paragraph summary

Customer Asterisk servers ("**processes**") send calls over SIP to this box. Asterisk identifies each customer by its
source IP, checks the SIP headers `X-DID` (caller ID) and `X-Number` (number to call), enforces per-process and
per-trunk channel limits and working hours, and sends the call out through a carrier SIP **trunk** with the DID as
caller ID. Calls from the carrier to a DID are routed back to the right customer. Everything is configured from a web
UI (Node.js, port 3000). The UI stores settings in PostgreSQL, renders three Asterisk config files into
`/etc/asterisk/sipdist/`, and reloads Asterisk through ARI. Live channel counts are kept in Redis; finished calls are
written to PostgreSQL (`calls`, `daily_stats`).
