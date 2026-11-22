#!/bin/sh
# Ticket 178 finding 20: a fake `claude` for the browser sign-in tests. Never a real login. The mode file under
# NUNCHIRO_HOME picks the run; the code is checked by its SHA-256, so the code string is in no file of the test home.
D="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$1" in --version) echo "2.1.316 (Claude Code)"; exit 0;; esac
if [ "$1 $2" = "auth status" ]; then
  [ -e "$D/.slow-status" ] && sleep 4
  if [ -e "$D/.logged-in" ]; then echo '{"loggedIn": true}'; exit 0; fi
  if [ -e "$D/.unknown" ]; then echo 'not json'; exit 1; fi
  echo '{"loggedIn": false}'; exit 1
fi
# The terminal login ("Sign in in a terminal instead"): the old tab's command, which waits like a real login.
if [ "$1 $2" = "auth login" ] && [ $# = 2 ]; then printf 'terminal login for %s\n' "$D"; exec sleep 600; fi
if [ "$1 $2 $3" = "auth login --claudeai" ] && [ $# = 3 ]; then
  H="$NUNCHIRO_HOME"
  echo $$ > "$H/login.pid"
  env > "$H/login.env.tmp" && mv "$H/login.env.tmp" "$H/login.env"
  pwd > "$H/login.cwd"
  mode=$(cat "$H/mode" 2>/dev/null)
  # The end state is set before the link: a test that sees "waiting" may cancel or stop the core at once.
  case "$mode" in
    signed-hang) touch "$D/.logged-in";;
    # Signed in, and its status answers slowly (a probe still running when the core stops).
    signed-slow) touch "$D/.logged-in" "$D/.slow-status";;
    unknown-hang) touch "$D/.unknown";;
  esac
  case "$mode" in
    exit3) exit 3;;
    nolink) exec sleep 600;;
    badlink) "$BROWSER" "https://claude.ai.evil.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback";;
    filelink) "$BROWSER" "file:///etc/passwd";;
    *) "$BROWSER" "https://claude.ai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=fake";;
  esac
  [ -x "$BROWSER" ] && echo helper > "$H/helper-seen"
  echo "Paste code here if prompted > "
  case "$mode" in
    # A child of its own, as a local callback server would be: cancel must stop it too.
    hang) sleep 600 & echo $! > "$H/child.pid"; exec sleep 600;;
    signed-hang|signed-slow|unknown-hang) exec sleep 600;;
    # Leaves a child running after it exits, as a login's callback server could.
    child-exit) sleep 600 & echo $! > "$H/child.pid";;
  esac
  IFS= read -r code
  if [ "$(printf '%s' "$code" | shasum -a 256 | cut -c1-64)" = 95627b93012ef6385e2cca0223c9046d3e08aa2fb7c4827981fdc8cef791d828 ]; then
    echo stdin > "$H/code-seen"
    # The code reached argv or env only if it is in them now.
    { env; printf '%s\n' "$0" "$@"; } | grep -q 'FAKE-CODE' && echo leak > "$H/code-leak"
    printf '{"token":"fake"}' > "$D/.credentials.json"
    chmod 000 "$D/.credentials.json"
    touch "$D/.logged-in"
    echo "Login successful."
    exit 0
  fi
  echo "OAuth error: invalid code" >&2
  exit 1
fi
exit 2
