#!/bin/sh
# V1B-01 spike: confine a fixture "script widget" with sandbox-exec + a loopback allow-list proxy.
# Prints one `PASS|FAIL <row>` line per acceptance row; exits 1 if any row FAILs. Writes only under .scratch/.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
RUN="$ROOT/.scratch/v1b-01-spike"
ID="nunchiro-spike-$$"
PIDS=""
rm -rf "$RUN" && mkdir -p "$RUN/cache" "$RUN/data" "$RUN/fake-claude"
echo "fake credential" > "$RUN/fake-claude/secret.txt"
echo "open me" > "$RUN/open-me.txt"
: > "$RUN/proxy.log"; : > "$RUN/core-tcp.log"; : > "$RUN/core-unix.log"

# Sentinels: a unique name per run, directly in each forbidden place; removed on exit whatever happens.
S_PROJ="$ROOT/$ID"; S_HOME="$HOME/$ID"; S_TMP="/tmp/$ID"; S_DATA="$RUN/data/$ID"
cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  rm -f "$S_PROJ" "$S_PROJ-osa" "$S_HOME" "$S_TMP" "$S_DATA" "$RUN/core.sock"
}
trap cleanup EXIT INT TERM

python3 "$HERE/proxy.py" "$RUN/proxy.port" "$RUN/proxy.log" example.com & PIDS="$PIDS $!"
python3 "$HERE/listener.py" tcp "$RUN/core.port" "$RUN/core-tcp.log" & PIDS="$PIDS $!"
python3 "$HERE/listener.py" unix "$RUN/core.sock" "$RUN/core-unix.log" & PIDS="$PIDS $!"
i=0; while [ $i -lt 50 ] && ! { [ -s "$RUN/proxy.port" ] && [ -s "$RUN/core.port" ] && [ -S "$RUN/core.sock" ]; }; do sleep 0.1; i=$((i+1)); done
PROXY_PORT=$(cat "$RUN/proxy.port"); CORE_PORT=$(cat "$RUN/core.port")
DIRECT_IP=$(python3 -c 'import socket;print(socket.gethostbyname("example.com"))')

echo "# macOS $(sw_vers -productVersion) build $(sw_vers -buildVersion); proxy 127.0.0.1:$PROXY_PORT; core stand-in tcp :$CORE_PORT unix $RUN/core.sock"

# The parent holds a fake secret; the child env is built from an allow-list, as the core will do.
NUNCHIRO_SESSION_TOKEN=fake-secret-do-not-leak; export NUNCHIRO_SESSION_TOKEN
PY=$(command -v python3)
/usr/bin/sandbox-exec -f "$HERE/widget.sb" -D "CACHE=$RUN/cache" -D "PROXY_PORT=$PROXY_PORT" -D "DENY_READ=$RUN/fake-claude" \
  /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$RUN/cache" TMPDIR="$RUN/cache" \
  https_proxy="http://127.0.0.1:$PROXY_PORT" HTTPS_PROXY="http://127.0.0.1:$PROXY_PORT" \
  "$PY" "$HERE/widget-fixture.py" "$RUN/cache" "$S_PROJ" "$S_HOME" "$S_TMP" "$S_DATA" \
  "$CORE_PORT" "$RUN/core.sock" "$PROXY_PORT" "$DIRECT_IP" "$RUN" "$RUN/fake-claude/secret.txt" > "$RUN/fixture.out" 2> "$RUN/fixture.err"
echo "# fixture exit $?; stderr: $(head -c 300 "$RUN/fixture.err")"
sleep 1

FAILS=0
res() { grep "^ROW $1 " "$RUN/fixture.out" | head -1 | cut -d' ' -f3; }
detail() { grep "^ROW $1 " "$RUN/fixture.out" | head -1 | cut -d' ' -f4-; }
check() { # check <row label> <ok|bad> <detail>
  if [ "$2" = ok ]; then echo "PASS $1 -- $3"; else echo "FAIL $1 -- $3"; FAILS=$((FAILS+1)); fi
}
want() { # want <fixture row> <expected result> <label>
  r=$(res "$1"); [ "$r" = "$2" ] && s=ok || s=bad; check "$3" "$s" "got '${r:-no output}': $(detail "$1")"
}

want read_control ok "control: reading an ordinary file works"
want read_secret denied "read of a denied secret folder (stand-in for ~/.claude) fails"
want write_cache ok "write inside widget cache succeeds"
[ -f "$RUN/cache/out.txt" ] || check "cache file exists on disk" bad "missing"
for pair in "write_project:$S_PROJ:project folder" "write_home:$S_HOME:\$HOME" "write_tmp:$S_TMP:/tmp" "write_data:$S_DATA:Nunchiro data folder (NUNCHIRO_HOME stand-in)"; do
  row=${pair%%:*}; rest=${pair#*:}; path=${rest%%:*}; label=${rest#*:}
  want "$row" denied "write to $label fails"
  if [ -e "$path" ]; then check "sentinel for $label absent on disk" bad "EXISTS, deleting"; rm -f "$path"; fi
done
want direct_tcp denied "direct TCP connect to $DIRECT_IP:443 fails"
want dns denied "DNS lookup fails"
want proxy_approved ok "HTTPS to approved host (example.com) via proxy succeeds"
want proxy_unapproved refused "HTTPS to unapproved host (example.org) via proxy is refused"
grep -q "^ALLOW example.com:443" "$RUN/proxy.log" && grep -q "^REFUSE example.org:443" "$RUN/proxy.log" \
  && check "proxy log shows ALLOW example.com and REFUSE example.org" ok "$(tr '\n' ';' < "$RUN/proxy.log")" \
  || check "proxy log shows ALLOW example.com and REFUSE example.org" bad "$(tr '\n' ';' < "$RUN/proxy.log")"
want env_secrets none "child env has no NUNCHIRO_*/TOKEN/SECRET variable"
want esc_noproxy denied "escape: curl --noproxy '*' cannot go direct"
want esc_own_proxy denied "escape: curl -x to the core's loopback port is refused (rc 7)"
want esc_own_proxy_env denied "escape: curl with its own https_proxy env is refused (rc 7)"
want esc_core_tcp denied "escape: TCP connect to core loopback port fails"
want esc_core_unix denied "escape: Unix socket to core fails"
[ ! -s "$RUN/core-tcp.log" ] && check "core loopback listener saw no connection" ok "0 accepts" || check "core loopback listener saw no connection" bad "$(wc -l < "$RUN/core-tcp.log") accepts"
[ ! -s "$RUN/core-unix.log" ] && check "core Unix listener saw no connection" ok "0 accepts" || check "core Unix listener saw no connection" bad "$(wc -l < "$RUN/core-unix.log") accepts"
want osascript_local ok "info: osascript -e 'return 1' runs in-process (no AppleEvent)"
want esc_osascript_finder denied "escape: osascript AppleEvent to Finder (NO CONTROL, not evidence)"
want esc_osascript_shell denied "escape: osascript 'do shell script' cannot write outside the cache"
[ -e "$S_PROJ-osa" ] && rm -f "$S_PROJ-osa"
want esc_open denied "escape: open -g -j <file in .scratch> fails"

echo "# fixture raw output: $RUN/fixture.out"
[ "$FAILS" -eq 0 ]
