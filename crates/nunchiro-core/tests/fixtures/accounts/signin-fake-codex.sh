#!/bin/sh
# Ticket 178 finding 20: a fake `codex` for the browser sign-in tests. Never a real login. It prints Orca's marker and
# an auth.openai.com link, then waits for the test to stand in for the browser callback (a file under NUNCHIRO_HOME).
D="${CODEX_HOME:-$HOME/.codex}"
case "$1" in --version) echo "codex-cli 0.161.0"; exit 0;; esac
if [ "$1 $2" = "login status" ]; then
  if [ -e "$D/.logged-in" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi
  echo "Not logged in" >&2; exit 1
fi
if [ "$1" = "login" ] && [ $# = 1 ]; then
  H="$NUNCHIRO_HOME"
  echo $$ > "$H/login.pid"
  env > "$H/login.env.tmp" && mv "$H/login.env.tmp" "$H/login.env"
  printf 'Starting local login server on http://localhost:1455.\n'
  # Split across writes: the link is complete only once the newline arrives.
  printf 'If your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?response_type=code'
  sleep 0.3
  printf '&redirect_uri=http%%3A%%2F%%2Flocalhost%%3A1455%%2Fauth%%2Fcallback&state=fake\n\n'
  while [ ! -e "$H/codex-callback" ]; do sleep 0.1; done
  printf '{"tokens":"fake"}' > "$D/auth.json"
  chmod 000 "$D/auth.json"
  touch "$D/.logged-in"
  echo "Successfully logged in"
  exit 0
fi
exit 2
