#!/usr/bin/env bash
# SIP engine switch for the SIP Channel Distributor — runs as root.
#   sipdist-engine asterisk|kamailio        make that engine the only one running, now and after a reboot
#   sipdist-engine --request                same, asked for by the web app (System → SIP engine, super admins):
#                                           reads "<engine> <nonce>" from $STATE/engine.request, answers in engine.result
# Installed as /usr/local/sbin/sipdist-engine by deploy/setup.sh; started by sipdist-engine.path when the app writes
# the request file. Live calls are dropped by a switch. If the new engine does not come up, the old one is started again.
set -uo pipefail
STATE=/var/lib/sipdist
APP=/opt/sipdist
KDIR=/etc/kamailio/sipdist
LOCK=/run/sipdist-engine.lock

NONCE=""
if [[ ${1:-} == --request ]]; then
  read -r TARGET NONCE _ < "$STATE/engine.request" || true
  [[ ${NONCE:-} =~ ^[a-f0-9]{8,32}$ ]] || { echo "bad request file"; exit 1; }
else
  TARGET=${1:-}
fi

answer() {   # ok(true|false) message
  echo "$2"
  if [[ -n $NONCE ]]; then
    local msg=${2//\\/ }; msg=${msg//\"/\'}; msg=${msg//$'\n'/ }
    printf '{"nonce":"%s","ok":%s,"engine":"%s","message":"%s"}\n' "$NONCE" "$1" "$TARGET" "$msg" > "$STATE/engine.result.tmp"
    chmod 644 "$STATE/engine.result.tmp"; mv -f "$STATE/engine.result.tmp" "$STATE/engine.result"
  fi
  [[ $1 == true ]]
}
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
[[ $TARGET == asterisk || $TARGET == kamailio ]] || { answer false "engine must be asterisk or kamailio"; exit 1; }
exec 9>"$LOCK"; flock -w 60 9 || { answer false "another engine switch is running"; exit 1; }

up() { systemctl is-active --quiet "$1"; }
wait_up() { for _ in $(seq 1 20); do up "$1" && return 0; sleep 0.5; done; return 1; }

start_asterisk() {
  systemctl disable --now kamailio rtpengine-daemon >/dev/null 2>&1
  systemctl enable asterisk >/dev/null 2>&1
  systemctl restart asterisk && wait_up asterisk
}

start_kamailio() {
  local err
  [[ -r $KDIR/kamailio.cfg && -r $KDIR/rtpengine.conf && -r $KDIR/data.lua ]] || { echo "the app has not written $KDIR yet"; return 1; }
  err=$(kamailio -c -f "$KDIR/kamailio.cfg" 2>&1) || { echo "kamailio.cfg is not valid: $(tail -n 3 <<<"$err")"; return 1; }

  # rtpengine reads its own file; keep the packaged one once
  [[ -f /etc/rtpengine/rtpengine.conf.dist || ! -f /etc/rtpengine/rtpengine.conf ]] || cp -a /etc/rtpengine/rtpengine.conf /etc/rtpengine/rtpengine.conf.dist
  install -m 644 "$KDIR/rtpengine.conf" /etc/rtpengine/rtpengine.conf

  # Kamailio: our config file, memory for thousands of calls, working-time checks in the app's time zone
  local tz; tz=$(sed -n 's/^STATS_TZ=//p' "$APP/.env" 2>/dev/null | tail -n 1); tz=${tz:-Asia/Kolkata}
  [[ $tz =~ ^[A-Za-z0-9_+/-]+$ ]] || tz=Asia/Kolkata
  mkdir -p /etc/systemd/system/kamailio.service.d
  cat > /etc/systemd/system/kamailio.service.d/sipdist.conf <<UNIT
# written by sipdist-engine
[Unit]
After=rtpengine-daemon.service redis-server.service
[Service]
Environment=CFGFILE=$KDIR/kamailio.cfg
Environment=SHM_MEMORY=512
Environment=PKG_MEMORY=32
Environment=TZ=$tz
LimitNOFILE=131072
UNIT
  systemctl daemon-reload

  systemctl disable --now asterisk >/dev/null 2>&1
  systemctl enable rtpengine-daemon kamailio >/dev/null 2>&1
  systemctl restart rtpengine-daemon && wait_up rtpengine-daemon || { echo "rtpengine did not start: $(journalctl -u rtpengine-daemon -n 3 --no-pager -o cat 2>/dev/null | tr '\n' ' ')"; return 1; }
  systemctl restart kamailio && wait_up kamailio || { echo "kamailio did not start: $(journalctl -u kamailio -n 4 --no-pager -o cat 2>/dev/null | tr '\n' ' ')"; return 1; }
}

if up kamailio; then WAS=kamailio; elif up asterisk; then WAS=asterisk; else WAS=""; fi
OUT=$(start_"$TARGET" 2>&1); RC=$?
if [[ $RC -eq 0 ]]; then
  answer true "$TARGET is running${WAS:+ (was: $WAS)}"
  exit 0
fi
# the new engine failed: go back so calls keep flowing
if [[ -n $WAS && $WAS != "$TARGET" ]]; then
  BACK=$(start_"$WAS" 2>&1) && OUT="$OUT — $WAS was started again" || OUT="$OUT — and $WAS could not be restarted: $BACK"
fi
answer false "$OUT"
exit 1
