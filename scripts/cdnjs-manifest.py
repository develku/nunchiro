#!/usr/bin/env python3
"""Developer script (V2-10c, needs 91): builds crates/nunchiro-core/data/cdnjs-sri.json, the shipped cdnjs manifest.

For each library below it asks cdnjs for the newest stable versions, then each version's published SRI hashes
(https://api.cdnjs.com/libraries/<Lib>/<version>?fields=sri, which answers {"sri": {"<file>": "sha512-...", ...}})
and keeps the `.js` files. The app never runs this or fetches the manifest: a refresh is a reviewed PR.

Usage: python3 scripts/cdnjs-manifest.py [--versions N] [--out PATH]
"""
import argparse
import base64
import binascii
import datetime
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

API = "https://api.cdnjs.com/libraries/"
CAP = 1024 * 1024
# One API answer; a larger one is refused, never truncated (V2-37).
RESPONSE_CAP = 4 * 1024 * 1024
# Popular script libraries as cdnjs names them (case kept: `Chart.js`).
LIBRARIES = [
    "Chart.js", "d3", "three.js", "lodash.js", "moment.js", "dayjs", "axios", "jquery", "vue", "react",
    "react-dom", "marked", "highlight.js", "mathjax", "KaTeX", "echarts", "plotly.js", "leaflet", "gsap",
    "animejs", "p5.js", "babel-standalone", "underscore.js", "dompurify", "alpinejs", "htmx", "PapaParse",
    "Sortable", "tone", "mermaid", "vega", "vega-lite", "vega-embed", "apexcharts", "chartjs-plugin-datalabels",
    "cytoscape", "fabric.js", "pixi.js", "matter-js", "popper.js", "tippy.js", "bootstrap", "js-yaml",
]
EXACT = re.compile(r"^\d+\.\d+\.\d+$")  # stable releases only


def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        body = r.read(RESPONSE_CAP + 1)
    if len(body) > RESPONSE_CAP:
        sys.exit(f"{url}: answer over {RESPONSE_CAP} bytes")
    return json.loads(body)


def sri_ok(h):
    """A `sha512-` value whose base64 decodes, strictly, to the 64 bytes of a SHA-512 digest."""
    if not isinstance(h, str) or not h.startswith("sha512-"):
        return False
    try:
        return len(base64.b64decode(h[len("sha512-"):], validate=True)) == 64
    except (binascii.Error, ValueError):
        return False


def key(v):
    return tuple(int(p) for p in v.split("."))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--versions", type=int, default=3)
    ap.add_argument("--out", default=str(pathlib.Path(__file__).resolve().parent.parent
                                         / "crates/nunchiro-core/data/cdnjs-sri.json"))
    args = ap.parse_args()
    libraries = {}
    for lib in LIBRARIES:
        name = urllib.parse.quote(lib, safe="")
        versions = sorted((v for v in get(f"{API}{name}?fields=versions")["versions"] if EXACT.match(v)),
                          key=key)[-args.versions:]
        for version in versions:
            sri = get(f"{API}{name}/{urllib.parse.quote(version, safe='')}?fields=sri").get("sri", {})
            files = {f: h for f, h in sri.items() if f.endswith(".js") and sri_ok(h)}
            if files:
                libraries.setdefault(lib, {})[version] = dict(sorted(files.items()))
        print(f"{lib}: {', '.join(libraries.get(lib, {}))}", file=sys.stderr)
    out = {
        "version": 1,
        "source": API + "<Lib>/<version>?fields=sri",
        "generated": datetime.date.today().isoformat(),
        "libraries": libraries,
    }
    text = json.dumps(out, indent=0, sort_keys=False, separators=(",", ":")) + "\n"
    if len(text.encode()) > CAP:
        sys.exit(f"manifest is {len(text.encode())} bytes, over {CAP}: list fewer libraries or versions")
    pathlib.Path(args.out).write_text(text)
    print(f"wrote {args.out} ({len(text.encode())} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
