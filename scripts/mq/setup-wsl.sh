#!/usr/bin/env bash
# Installs IBM MQ Advanced for Developers in WSL Ubuntu (or any Ubuntu x64) and
# sets up queue manager QM1 for trying mc's MQ panes against. Run from the
# repository, as root:
#
#   wsl -d Ubuntu-24.04 -u root -- bash scripts/mq/setup-wsl.sh --accept-license
#
# Running it again installs nothing twice: it starts QM1 if it is down and
# reapplies dev-qm.mqsc. MQ_VERSION picks another level from IBM's mqadv
# download folder; MQ_APP_PASSWORD another password for mcapp.
set -euo pipefail

VERSION=${MQ_VERSION:-10.0.1.0}
QMGR=QM1
PORT=1414
APP_USER=mcapp
APP_PASSWORD=${MQ_APP_PASSWORD:-passw0rd}
URL="https://public.dhe.ibm.com/ibmdl/export/pub/software/websphere/messaging/mqadv/$VERSION-IBM-MQ-Advanced-for-Developers-UbuntuLinuxX64.tar.gz"
HERE=$(cd "$(dirname "$0")" && pwd)

if [ "$(id -u)" != 0 ]; then
  echo "Run as root: wsl -d Ubuntu-24.04 -u root -- bash scripts/mq/setup-wsl.sh --accept-license" >&2
  exit 1
fi

if [ ! -x /opt/mqm/bin/crtmqm ]; then
  if [ "${1:-}" != --accept-license ]; then
    echo "IBM MQ Advanced for Developers is free for development, under IBM's licence," >&2
    echo "which the download carries in MQServer/licenses. Run again with --accept-license" >&2
    echo "to accept it and install." >&2
    exit 1
  fi
  work=$(mktemp -d)
  echo "Downloading $URL"
  curl -fL "$URL" | tar -xz -C "$work"
  cd "$(dirname "$(find "$work" -name mqlicense.sh | head -n 1)")"
  ./mqlicense.sh -accept
  # The server and the samples (amqsput, amqsbcg) are enough for a test
  # queue manager; the rest of the packages are left out.
  debs=()
  for p in runtime gskit server samples; do
    for f in ./ibmmq-"$p"_*.deb; do [ -e "$f" ] && debs+=("$f"); done
  done
  apt-get install -y "${debs[@]}"
  cd /
  rm -rf "$work"
  # Puts dspmq, strmqm and the rest on PATH.
  /opt/mqm/bin/setmqinst -i -p /opt/mqm
fi

as_mqm() { runuser -u mqm -- "$@"; }

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd -M -s /usr/sbin/nologin -G mqm "$APP_USER"
fi
# SHA-512 rather than Ubuntu's default yescrypt, to be sure MQ's own password
# check can read it.
echo "$APP_USER:$APP_PASSWORD" | chpasswd -c SHA512

created=no
if ! as_mqm /opt/mqm/bin/dspmq -m "$QMGR" >/dev/null 2>&1; then
  as_mqm /opt/mqm/bin/crtmqm "$QMGR"
  created=yes
fi
if ! as_mqm /opt/mqm/bin/dspmq -m "$QMGR" | grep -q 'STATUS(Running)'; then
  as_mqm /opt/mqm/bin/strmqm "$QMGR"
fi

as_mqm /opt/mqm/bin/runmqsc "$QMGR" < "$HERE/dev-qm.mqsc"
# Already running after the first time, which runmqsc answers with an error.
echo "START LISTENER('DEV.LISTENER.TCP')" | as_mqm /opt/mqm/bin/runmqsc "$QMGR" >/dev/null || true

if [ "$created" = yes ]; then
  # Something to look at on the first queue.
  printf '%s\n' 'Hello from QM1' '{"order": 1, "item": "widget"}' '<order id="2"><item>gadget</item></order>' \
    | as_mqm /opt/mqm/samp/bin/amqsput DEV.QUEUE.1 "$QMGR" >/dev/null
fi

sleep 1
if ! ss -ltn | grep -q ":$PORT "; then
  echo "Nothing listens on port $PORT; see /var/mqm/qmgrs/$QMGR/errors/AMQERR01.LOG" >&2
  exit 1
fi

cat <<EOF

$QMGR is running and listening on port $PORT.
Connect with: host localhost, port $PORT, queue manager $QMGR,
channel DEV.APP.SVRCONN, user $APP_USER, password $APP_PASSWORD.
EOF
