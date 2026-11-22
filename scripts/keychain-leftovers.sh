#!/bin/sh
# Ticket 1033: lists the "Nunchiro core start" keychain items (both services) whose home folder no longer exists.
# Read-only: `security dump-keychain` without -d prints attributes only, never a secret value; nothing is deleted.
# Prints the count, then one home path per line. Usage: scripts/keychain-leftovers.sh [keychain]
set -eu
kc=${1:-"$HOME/Library/Keychains/login.keychain-db"}
security dump-keychain "$kc" | python3 -I -c '
import os, re, sys
owner = os.path.realpath(os.path.expanduser("~/.nunchiro"))
gone = set()
for item in sys.stdin.read().split("keychain: ")[1:]:
    svce = re.search(r"\"svce\"<blob>=\"([^\"]*)\"", item)
    acct = re.search(r"\"acct\"<blob>=\"([^\"]*)\"", item)
    if not svce or not acct or not svce.group(1).startswith("Nunchiro core start"):
        continue
    home = acct.group(1)
    if os.path.realpath(home) != owner and not os.path.exists(home):  # the owner home is never listed
        gone.add(home)
print(len(gone))
for home in sorted(gone):
    print(home)
'
