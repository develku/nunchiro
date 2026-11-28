#!/usr/bin/env python3
"""List the agents of a running Nunchiro core through its local API. Standard library only.

    NUNCHIRO_TOKEN=$(nunchiro token create --scope read) python3 agents.py

Without NUNCHIRO_TOKEN it reads the owner token from $NUNCHIRO_HOME/core.token, as the CLI does.
The request and the answer are described in ../nunchiro-api.schema.json (op "agent_list").
"""
import json
import os
import socket
import sys
from pathlib import Path

HOME = Path(os.environ.get("NUNCHIRO_HOME") or Path.home() / ".nunchiro")


def call(request):
    """Sends one envelope line to core.sock and returns the answer, or exits with the core's refusal."""
    token = os.environ.get("NUNCHIRO_TOKEN") or (HOME / "core.token").read_text()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(15)
        s.connect(str(HOME / "core.sock"))
        s.sendall((json.dumps({"token": token, "request": request}) + "\n").encode())
        line = s.makefile(encoding="utf-8").readline()
    response = json.loads(line)
    if "Err" in response:
        sys.exit(f"nunchiro: {response['Err']}")
    return response["Ok"]


def main():
    reply = call({"op": "agent_list"})
    sessions = reply["sessions"]
    if not sessions:
        print("no agents")
    for s in sessions:
        print(f"{s.get('label') or '-':24} {s['kind']:8} {s['state']:10} {s['project']}")


if __name__ == "__main__":
    main()
