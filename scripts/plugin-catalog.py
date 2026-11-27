#!/usr/bin/env python3
"""Writes plugins/catalog.json, the catalogue the window's Browse plugins reads (docs/plugins.md).

Usage: scripts/plugin-catalog.py [<plugin folder>...]
With no folder, the folders already in the catalogue are read again.

Each entry pins the plugin to the last commit that changed its folder, and lists every file in it with its
SHA-256. The core installs only files that match. So run this on main after the plugin's change has landed, and
commit the catalogue on its own. A catalogued plugin that is edited fails the core's catalogue test until this runs.
"""
import hashlib
import json
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "plugins" / "catalog.json"
KINDS = {"panel": "panel", "command": "command", "setting": "setting", "gate": "check"}


def entry(folder: str) -> dict:
    path = ROOT / folder
    manifest = tomllib.loads((path / "plugin.toml").read_text())
    commit = subprocess.run(
        ["git", "log", "-1", "--format=%H", "--", folder], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    if len(commit) != 40:
        sys.exit(f"{folder}: no commit has it yet; commit the plugin first")
    files = sorted(p for p in path.rglob("*") if p.is_file())
    parts = [p for kind in KINDS for p in manifest.get(kind, [])]
    out = {
        "id": manifest["id"],
        "name": manifest["name"],
        "about": manifest.get("about", ""),
        "version": manifest["version"],
        "adds": {KINDS[k]: len(manifest[k]) for k in KINDS if manifest.get(k)},
        "network": sorted({h for p in parts for h in p.get("network", [])}),
        "commit": commit,
        "dir": folder,
        "files": [
            {"path": str(f.relative_to(path)), "sha256": hashlib.sha256(f.read_bytes()).hexdigest()} for f in files
        ],
    }
    if manifest.get("author"):
        out["author"] = manifest["author"]
    return out


def main() -> None:
    folders = sys.argv[1:] or [e["dir"] for e in json.loads(OUT.read_text())["plugins"]]
    catalog = {"version": 1, "plugins": [entry(f.rstrip("/")) for f in folders]}
    OUT.write_text(json.dumps(catalog, indent=2) + "\n")
    print(f"{OUT.relative_to(ROOT)}: {len(catalog['plugins'])} plugins")


if __name__ == "__main__":
    main()
