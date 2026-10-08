#!/usr/bin/env bash
# SIP Channel Distributor — one-shot installer.
#   sudo PUBLIC_IP=1.2.3.4 bash deploy/setup.sh
#   PUBLIC_IP   = the IP customers send calls to (may be private, e.g. 172.20.10.201)
#   EXTERNAL_IP = only if this box is behind NAT and talks to carriers/customers on the internet:
#                 the public NAT address. Leave empty on a flat LAN or when PUBLIC_IP is already public.
#   ASTERISK_MODE = integrate (default: keep your Asterisk config, only add includes, no restart)
#                   full (replace with the lightweight module set — restarts Asterisk, auto-rollback)
# Optional env: DB_HOST DB_PORT DB_NAME DB_USER DB_PASS ARI_USER ARI_PASS ADMIN_PASSWORD HTTP_PORT
# Safe to re-run: keeps your existing /opt/sipdist/.env and data.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }
: "${PUBLIC_IP:?set PUBLIC_IP=<ip customers send calls to>}"
EXTERNAL_IP=${EXTERNAL_IP:-}

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/sipdist
AST=/etc/asterisk
DB_HOST=${DB_HOST:-127.0.0.1}; DB_PORT=${DB_PORT:-5432}
DB_NAME=${DB_NAME:-channel_bank}; DB_USER=${DB_USER:-channel_bank}; DB_PASS=${DB_PASS:-Channels@123}
ARI_USER=${ARI_USER:-channel_ari}; ARI_PASS=${ARI_PASS:-chbank@123}
HTTP_PORT=${HTTP_PORT:-3000}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14)}

say() { echo -e "\n\033[1;32m==> $*\033[0m"; }
PKG=$(command -v apt-get || command -v dnf || command -v yum || true)

command -v asterisk >/dev/null || { echo "Asterisk not found — install Asterisk 18+ first"; exit 1; }
command -v redis-server >/dev/null || command -v redis-cli >/dev/null || { echo "Redis not found — install redis first"; exit 1; }

# ---------------------------------------------------------------- Node.js
if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 20 )); then
  say "Installing Node.js 24"
  if [[ $PKG == *apt-get ]]; then curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
  else curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - && $PKG install -y nodejs; fi
fi

# ---------------------------------------------------------------- PostgreSQL
if ! command -v psql >/dev/null; then
  say "Installing PostgreSQL"
  if [[ $PKG == *apt-get ]]; then apt-get install -y postgresql
  else $PKG install -y postgresql-server && postgresql-setup --initdb && systemctl enable --now postgresql; fi
fi
if [[ $DB_HOST == 127.0.0.1 || $DB_HOST == localhost ]] && id postgres >/dev/null 2>&1; then
  say "Ensuring database $DB_NAME / role $DB_USER"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${DB_USER}') THEN
    CREATE ROLE "${DB_USER}" LOGIN PASSWORD '${DB_PASS}';
  END IF;
END\$\$;
SQL
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
    sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
fi

# ---------------------------------------------------------------- Redis (loopback only)
for RC in /etc/redis/redis.conf /etc/redis.conf; do
  if [[ -f $RC ]] && ! grep -qE '^bind 127\.0\.0\.1' "$RC"; then
    say "Binding Redis to 127.0.0.1"; sed -i 's/^bind .*/bind 127.0.0.1 ::1/' "$RC"
    systemctl restart redis-server 2>/dev/null || systemctl restart redis 2>/dev/null || true
  fi
done

# ---------------------------------------------------------------- Asterisk base config
BK="$AST/backup-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BK"
NEED_MODS="res_pjsip_endpoint_identifier_ip.so res_pjsip_endpoint_identifier_user.so res_pjsip_outbound_registration.so app_dial.so app_userevent.so func_groupcount.so func_channel.so func_callerid.so func_logic.so pbx_config.so res_ari.so res_ari_channels.so res_ari_events.so res_ari_asterisk.so res_ari_endpoints.so"
if [[ ${ASTERISK_MODE:-integrate} == full ]]; then
  say "Writing Asterisk base config (backup in $AST/backup-*)"
  MODDIR=$(asterisk -rx 'core show settings' 2>/dev/null | awk -F': *' '/Module directory/{print $2}' | tr -d ' ')
  [[ -d $MODDIR ]] || MODDIR=/usr/lib/asterisk/modules; [[ -d $MODDIR ]] || MODDIR=/usr/lib64/asterisk/modules
  for f in "$SRC"/deploy/asterisk/*.conf; do
    n=$(basename "$f"); [[ -f $AST/$n ]] && cp -a "$AST/$n" "$BK/"
    sed -e "s/__EXTERNAL_IP__/$EXTERNAL_IP/g" -e "s/__ARI_USER__/$ARI_USER/g" -e "s/__ARI_PASS__/$ARI_PASS/g" \
        -e "s/__DB_HOST__/$DB_HOST/g" -e "s/__DB_PORT__/$DB_PORT/g" -e "s/__DB_NAME__/$DB_NAME/g" \
        -e "s/__DB_USER__/$DB_USER/g" -e "s/__DB_PASS__/$DB_PASS/g" "$f" > "$AST/$n"
  done
  sed -i "s#/usr/lib/asterisk/modules#$MODDIR#" "$AST/asterisk.conf"
  # no NAT address given -> remove the external_* lines (flat LAN / box already on a public IP)
  [[ -n $EXTERNAL_IP ]] || sed -i '/^external_\(media\|signaling\)_address=/d' "$AST/pjsip.conf"
  # comment out modules this Asterisk build does not have
  while read -r mod; do
    [[ -f $MODDIR/$mod ]] || { echo "  module $mod not present - skipped"; sed -i "s/^load => $mod/;load => $mod   ; not installed/" "$AST/modules.conf"; }
  done < <(grep -oP '^load => \K\S+' "$AST/modules.conf")
  mkdir -p "$AST/sipdist"
  for n in trunks processes dialplan; do [[ -f $AST/sipdist/$n.conf ]] || echo "; empty until first apply" > "$AST/sipdist/$n.conf"; done
  chown -R asterisk:asterisk "$AST/sipdist"; chmod 750 "$AST/sipdist"
  chown asterisk:asterisk "$AST"/*.conf 2>/dev/null || true

else
  say "Adding SIP distributor includes to your existing Asterisk config (backup in $BK)"
  cp -a "$AST"/{pjsip,extensions,modules}.conf "$BK"/ 2>/dev/null || true
  grep -q 'sipdist/trunks.conf'    "$AST/pjsip.conf"      || printf '\n; SIP Channel Distributor (generated from the web UI)\n#tryinclude sipdist/trunks.conf\n#tryinclude sipdist/processes.conf\n' >> "$AST/pjsip.conf"
  grep -q 'sipdist/dialplan.conf'  "$AST/extensions.conf" || printf '\n; SIP Channel Distributor (generated from the web UI)\n#tryinclude sipdist/dialplan.conf\n' >> "$AST/extensions.conf"
  # password-auth processes are matched by digest username -> auth_username must be in the identifier order
  if ! grep -q '^endpoint_identifier_order' "$AST/pjsip.conf"; then
    if grep -q '^type=global' "$AST/pjsip.conf"; then
      sed -i '0,/^type=global/s//type=global\nendpoint_identifier_order=ip,auth_username,username,anonymous/' "$AST/pjsip.conf"
    else
      printf '\n[global]\ntype=global\nendpoint_identifier_order=ip,auth_username,username,anonymous\n' >> "$AST/pjsip.conf"
    fi
  elif ! grep -q '^endpoint_identifier_order=.*auth_username' "$AST/pjsip.conf"; then
    echo "  NOTE: add auth_username to endpoint_identifier_order in pjsip.conf for password-auth processes"
  fi
  # make sure the few modules we need are not disabled
  for m in $NEED_MODS; do
    sed -i "s/^noload *=> *$m/;noload => $m   ; needed by sipdist/" "$AST/modules.conf"
    if grep -q '^autoload *= *no' "$AST/modules.conf" && ! grep -q "^load *=> *$m" "$AST/modules.conf"; then echo "load => $m" >> "$AST/modules.conf"; fi
  done
  mkdir -p "$AST/sipdist"
  for n in trunks processes dialplan; do [[ -f $AST/sipdist/$n.conf ]] || echo "; empty until first apply" > "$AST/sipdist/$n.conf"; done
  chown -R asterisk:asterisk "$AST/sipdist"; chmod 750 "$AST/sipdist"
  # no restart: load missing modules and reload config live
  for m in $NEED_MODS; do asterisk -rx "module show like ${m%.so}" | grep -q Running || asterisk -rx "module load $m" >/dev/null 2>&1 || true; done
  asterisk -rx 'module reload res_pjsip.so' >/dev/null; asterisk -rx 'dialplan reload' >/dev/null
  for m in func_groupcount app_userevent res_ari_events; do
    asterisk -rx "module show like $m" | grep -q Running || echo "  WARNING: module $m is not running — check: asterisk -rx 'module load $m.so'"
  done
fi

# ---------------------------------------------------------------- app
say "Deploying app to $APP"
mkdir -p "$APP"
cp -a "$SRC"/{package.json,src,public,db,deploy,test} "$APP"/
[[ -f $SRC/package-lock.json ]] && cp "$SRC/package-lock.json" "$APP/"
cd "$APP" && npm install --omit=dev --no-audit --no-fund --silent
if [[ ! -f $APP/.env ]]; then
  cat > "$APP/.env" <<ENV
HTTP_HOST=0.0.0.0
HTTP_PORT=$HTTP_PORT
SESSION_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
ADMIN_PASSWORD=$ADMIN_PASSWORD
PUBLIC_IP=$PUBLIC_IP
SIP_PORT=5060
ARI_URL=http://127.0.0.1:8088
ARI_USER=$ARI_USER
ARI_PASS=$ARI_PASS
ARI_APP=sipdist
ASTERISK_CONF_DIR=$AST/sipdist
ASTERISK_RELOAD=1
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASS=$DB_PASS
REDIS_URL=redis://127.0.0.1:6379/0
STATS_TZ=Asia/Kolkata
ENV
else
  ADMIN_PASSWORD="(unchanged — see $APP/.env or change it in the UI)"
fi
chown -R asterisk:asterisk "$APP"; chmod 600 "$APP/.env"

say "Creating tables"
sudo -u asterisk node --env-file="$APP/.env" "$APP/src/cli/dbinit.js"

say "Raising Asterisk open-file / thread limits and UDP buffers (for many concurrent calls)"
mkdir -p /etc/systemd/system/asterisk.service.d
cp "$SRC/deploy/asterisk-limits.conf" /etc/systemd/system/asterisk.service.d/sipdist-limits.conf
cp "$SRC/deploy/sysctl-sipdist.conf" /etc/sysctl.d/90-sipdist.conf
sysctl -q -p /etc/sysctl.d/90-sipdist.conf || true
systemctl daemon-reload
if [[ ${ASTERISK_MODE:-integrate} != full ]]; then
  grep -q '^rtpend=30000' "$AST/rtp.conf" || echo "  NOTE: for >2500 calls set rtpstart=10000 rtpend=30000 in $AST/rtp.conf"
  echo "  NOTE: the new limits apply after 'systemctl restart asterisk' (drops live calls — do it when idle)"
fi

if [[ ${ASTERISK_MODE:-integrate} == full ]]; then
say "Restarting Asterisk with the lightweight module set"
systemctl restart asterisk
UP=0; for i in $(seq 1 20); do sleep 1; asterisk -rx 'core show version' >/dev/null 2>&1 && { UP=1; break; }; done
if [[ $UP -ne 1 ]]; then
  echo "!! Asterisk did not start with the new config — restoring $BK and restarting"
  journalctl -u asterisk -n 40 --no-pager | tail -40 > /tmp/sipdist-asterisk-fail.log
  tail -40 /var/log/asterisk/messages.log >> /tmp/sipdist-asterisk-fail.log 2>/dev/null || true
  cp -a "$BK"/*.conf "$AST"/ && systemctl restart asterisk
  echo "!! Reason saved in /tmp/sipdist-asterisk-fail.log — send it for a fix. Stopping here."; exit 1
fi
asterisk -rx 'module show like res_ari' | tail -1 || true
fi

say "Starting sipdist service"
cp "$SRC/deploy/sipdist.service" /etc/systemd/system/sipdist.service
systemctl daemon-reload && systemctl enable --now sipdist && systemctl restart sipdist
sleep 2; systemctl --no-pager --lines=5 status sipdist || true

cat <<DONE

  SIP Channel Distributor is running.
  UI:        http://$PUBLIC_IP:$HTTP_PORT     (firewall: allow only your office IP)
  NAT:       ${EXTERNAL_IP:-none (external_* lines removed from pjsip.conf)}
  Login:     admin / $ADMIN_PASSWORD
  SIP:       customers send to $PUBLIC_IP:5060 (UDP/TCP), RTP 10000-30000
  Logs:      journalctl -u sipdist -f
DONE
