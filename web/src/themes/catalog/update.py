#!/usr/bin/env python3
"""Regenerate the bundled theme catalog from an iTerm2-Color-Schemes checkout.

Usage: python3 -I web/src/themes/catalog/update.py <checkout>
Bundles the curated ALLOWLIST of `ghostty/` files, each only when its licence in `licenses.yml` is permissive (see
PERMISSIVE). For each one it fetches the licence file of the theme's upstream GitHub source (the `source` in
licenses.yml) at a pinned commit (upstream-pins.json): MIT, ISC, Zlib, 0BSD and BSD need the author's copyright
notice to travel with the copy, so a theme whose notice cannot be found mechanically is dropped; Apache-2.0 themes
carry the upstream NOTICE file when there is one. Writes catalog.gen.ts (file text verbatim plus each theme's
copyright lines), NOTICES.md (per-theme licence, source, copyright and the upstream licence texts) and
LICENSE.iTerm2-Color-Schemes next to this script. GitHub requests use $GITHUB_TOKEN or `gh auth token`.
"""
import base64
import hashlib
import html
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request

# Owner pick (owner 2026-10-26, needs 70, V1A-62): Nunchiro Light/Dark plus these two; every other theme stays reachable
# through Browse themes online. A theme here still needs a permissive licence and, where its licence requires one, its
# author's notice; otherwise it is dropped.
ALLOWLIST = ['Catppuccin Mocha', 'Catppuccin Latte']
PERMISSIVE = {'MIT', 'Apache-2.0', 'CC0-1.0', 'ISC', '0BSD', 'Zlib', 'Unlicense', 'WTFPL', 'BSD-2-Clause', 'BSD-3-Clause'}
# Licences whose terms require the copyright notice to accompany copies.
NEEDS_NOTICE = {'MIT', 'ISC', '0BSD', 'Zlib', 'BSD-2-Clause', 'BSD-3-Clause'}
OUT = pathlib.Path(__file__).resolve().parent
PINS = OUT / 'upstream-pins.json'
# A copyright notice names a year or the (c)/© mark; it may sit mid-line ("The MIT License (MIT) Copyright (c) 2012 ...").
# Template lines ([yyyy], <year>, {owner}) are not notices.
COPYRIGHT = re.compile(r'(copyright\b[^\n]*?(\d{4}|\(c\)|©)[^\n]*|©\s*\d{4}[^\n]*)', re.I)
TEMPLATE = re.compile(r'\[yyyy\]|\[year\]|<year>|\{yyyy\}|\{year\}|\[name of copyright owner\]|<copyright holders?>', re.I)


def licences(path):
    """Reads licenses.yml: top-level keys, each with indented `key: value` lines (no YAML library needed)."""
    out, cur = {}, None
    for line in path.read_text().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        if not line.startswith(' '):
            key = line.rstrip()[:-1]
            if key[:1] == "'":
                key = key[1:-1].replace("''", "'")
            elif key[:1] == '"':
                key = json.loads(key)
            cur = out.setdefault(key, {})
        else:
            m = re.match(r'\s+(\w+):\s*(.*)', line)
            v = m.group(2).strip()
            if v[:1] in '\'"':
                v = v[1:-1]
            cur[m.group(1)] = v
    return out


def token():
    if os.environ.get('GITHUB_TOKEN'):
        return os.environ['GITHUB_TOKEN']
    try:
        return subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ''


def fetch(url, headers=None):
    """The body, or None for HTTP 404 (nothing there). Any other failure stops the run: a rate limit or outage must
    never read as "no licence" and silently drop themes."""
    req = urllib.request.Request(url, headers={'User-Agent': 'nunchiro-catalog-update', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        sys.exit(f'update.py: {url} answered HTTP {e.code}; stopping (rerun later or set GITHUB_TOKEN).')
    except (urllib.error.URLError, TimeoutError) as e:
        sys.exit(f'update.py: {url} failed ({e}); stopping.')


class Upstream:
    """Fetches and caches each source's licence: {'text', 'spdx', 'url', 'notice'} or None.

    Every GitHub source is read at the commit pinned in PINS, so a rerun from the same pins gives the same output.
    A source without a pin is pinned to its current head on first use; delete its line in PINS to move it forward.
    A source that is not a GitHub repo has no licence lookup (the theme is dropped if it needs a notice).
    """

    def __init__(self):
        self.gh = {'Accept': 'application/vnd.github+json'}
        if t := token():
            self.gh['Authorization'] = f'Bearer {t}'
        self.cache = {}
        self.pins = json.loads(PINS.read_text()) if PINS.exists() else {}
        self.used = set()

    def pin(self, key, resolve):
        if not self.pins.get(key):
            ref = resolve()
            # No head (commits/HEAD answered 404): store nothing, so a later run tries again instead of keeping null.
            if not ref:
                return None
            self.pins[key] = ref
        self.used.add(key)
        return self.pins[key]

    def github(self, owner, repo):
        api = f'https://api.github.com/repos/{owner}/{repo}'
        head = lambda: (json.loads(fetch(f'{api}/commits/HEAD', self.gh) or 'null') or {}).get('sha')
        ref = self.pin(f'github.com/{owner}/{repo}'.lower(), head)
        if not ref:
            return None
        body = fetch(f'{api}/license?ref={ref}', self.gh)
        if not body:
            # No licence file: the README may state the licence and its copyright line.
            readme = fetch(f'{api}/readme?ref={ref}', self.gh)
            if not readme:
                return None
            j = json.loads(readme)
            return {'text': base64.b64decode(j['content']).decode('utf-8', 'replace'), 'spdx': None, 'url': f"{j['html_url']} (README at {ref})", 'notice': None, 'readme': True}
        j = json.loads(body)
        out = {
            'text': base64.b64decode(j['content']).decode('utf-8', 'replace'),
            'spdx': (j.get('license') or {}).get('spdx_id'),
            'url': f"https://github.com/{owner}/{repo}/blob/{ref}/{j['path']}",
            'notice': None,
        }
        for name in ('NOTICE', 'NOTICE.txt', 'NOTICE.md'):
            if n := fetch(f'{api}/contents/{name}?ref={ref}', self.gh):
                out['notice'] = base64.b64decode(json.loads(n)['content']).decode('utf-8', 'replace')
                break
        return out

    def lookup(self, source):
        if m := re.match(r'https://github\.com/([^/]+)/([^/#?]+)', source):
            key = ('github', m.group(1).lower(), m.group(2).lower().removesuffix('.git'))
            if key not in self.cache:
                self.cache[key] = self.github(m.group(1), m.group(2).removesuffix('.git'))
            return self.cache[key]
        return None


def copyrights(text):
    plain = re.sub(r'^\s*>+|[*_`#]+', ' ', html.unescape(text or ''), flags=re.M)
    lines = (re.sub(r'\s+', ' ', m.group(0)).strip() for m in COPYRIGHT.finditer(plain))
    # A notice names its holder: a bare "Copyright © 2026" (a page filling in the year) is not one.
    holder = lambda l: len(re.findall(r'[^\W\d_]', re.sub(r'copyright|\(c\)|present', '', l, flags=re.I))) >= 2
    return list(dict.fromkeys(l for l in lines if not TEMPLATE.search(l) and len(l) < 300 and holder(l)))


def main(src):
    src = pathlib.Path(src)
    commit = subprocess.run(['git', '-C', str(src), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
    lic = licences(src / 'licenses.yml')
    up = Upstream()
    kept, dropped, texts = {}, {}, {}
    for n in ALLOWLIST:
        if not (src / 'ghostty' / n).is_file() or n not in lic:
            dropped[n] = 'not in iTerm2-Color-Schemes ghostty/'
            continue
        if lic[n].get('license') not in PERMISSIVE:
            dropped[n] = f"licence is {lic[n].get('license')}, not a permissive one"
            continue
        spdx, source = lic[n]['license'], lic[n].get('source') or ''
        found = up.lookup(source) if source else None
        if found and found['spdx'] and found['spdx'] not in PERMISSIVE | {'NOASSERTION', 'NONE'}:
            dropped[n] = f"upstream licence is {found['spdx']}, not {spdx}"
            continue
        lines = copyrights(found and found['text'])
        if spdx in NEEDS_NOTICE and not lines:
            dropped[n] = 'no copyright notice found upstream' if found else 'upstream licence not reachable'
            continue
        entry = {'licence': spdx, 'source': source or '(none listed)', 'copyright': lines, 'url': found and found['url']}
        # Only a real licence file is kept as text; a web page is only searched for its copyright line.
        if found and not found.get('readme') and (found['spdx'] is not None or found['url'].startswith('https://gitlab.com/')):
            digest = hashlib.sha256(found['text'].encode()).hexdigest()[:12]
            texts.setdefault(digest, (found['url'], found['text']))
            entry['text'] = digest
        if found and found['notice']:
            digest = hashlib.sha256(found['notice'].encode()).hexdigest()[:12]
            texts.setdefault(digest, (f"NOTICE beside {found['url']}", found['notice']))
            entry['notice'] = digest
        kept[n] = entry
    themes = {n: (src / 'ghostty' / n).read_text() for n in kept}
    notices = {n: {'licence': e['licence'], 'source': e['source'], 'copyright': e['copyright']} for n, e in kept.items()}
    (OUT / 'catalog.gen.ts').write_text(
        f'// Generated by update.py from iTerm2-Color-Schemes {commit} (MIT; per-theme licences in NOTICES.md). Do not edit.\n'
        f'export const COMMIT = {json.dumps(commit)};\n'
        f'export const THEMES: Record<string, string> = {json.dumps(themes, indent=0, ensure_ascii=False)};\n'
        f'/** Each theme\'s licence, source and author\'s copyright notice; the Theme page shows them (texts in NOTICES.md). */\n'
        f'export const LICENCES: Record<string, {{ licence: string; source: string; copyright: string[] }}> = {json.dumps(notices, indent=0, ensure_ascii=False)};\n'
    )
    cell = lambda s: s.replace('|', '\\|').replace('\n', '<br>')
    rows = '\n'.join(
        f"| {cell(n)} | {e['licence']} | {cell(e['source'])} | {cell(chr(10).join(e['copyright'])) or '(none required)'} | {e.get('text', '')} {e.get('notice', '')} |"
        for n, e in kept.items()
    )
    gone = '\n'.join(f'| {cell(n)} | {lic.get(n, {}).get("license", "")} | {cell(lic.get(n, {}).get("source") or "")} | {r} |' for n, r in dropped.items())
    full = '\n\n'.join(f'### {d}\n\nFrom {u}\n\n```text\n{t.strip()}\n```' for d, (u, t) in texts.items())
    (OUT / 'NOTICES.md').write_text(
        f'# Bundled theme catalog\n\n'
        f'Source: https://github.com/mbadolato/iTerm2-Color-Schemes `ghostty/` at commit `{commit}`.\n'
        f'Collection licence: MIT, Copyright (c) 2011 to Present Mark Badolato (LICENSE.iTerm2-Color-Schemes).\n'
        f'A curated set (update.py ALLOWLIST). Each theme keeps its own licence (upstream `licenses.yml`); only these\n'
        f'permissive ones are accepted (what is bundled is listed below):\n'
        f'{", ".join(sorted(PERMISSIVE))}. Themes under {", ".join(sorted(NEEDS_NOTICE))} are bundled only with their\n'
        f'author\'s copyright notice, taken from the licence file of the theme\'s upstream source; Apache-2.0 themes carry\n'
        f'the upstream NOTICE file when one exists. Regenerate with `python3 -I update.py <checkout>`.\n\n'
        f'{len(kept)} themes bundled (licences: {", ".join(sorted({e["licence"] for e in kept.values()}))}), {len(dropped)} of the allowlist dropped.\n\n'
        f'| Theme | Licence | Source | Copyright | Licence text (below) |\n|---|---|---|---|---|\n{rows}\n\n'
        f'## Dropped\n\n| Theme | Licence | Source | Why |\n|---|---|---|---|\n{gone}\n\n'
        f'## Upstream licence and NOTICE texts\n\n{full}\n'
    )
    (OUT / 'LICENSE.iTerm2-Color-Schemes').write_text((src / 'LICENSE').read_text())
    PINS.write_text(json.dumps({k: up.pins[k] for k in sorted(up.used)}, indent=1) + '\n')
    print(len(kept), 'themes kept,', len(dropped), 'dropped, at', commit)


def check():
    """`update.py --check`: notice extraction on known shapes, no network."""
    assert copyrights('The MIT License (MIT) Copyright (c) 2012 John-Paul Bader\n') == ['Copyright (c) 2012 John-Paul Bader']
    assert copyrights('### Copyright &copy; 2022 - 2024 **Raziel Anarki**') == ['Copyright © 2022 - 2024 Raziel Anarki']
    assert copyrights('Copyright (c) 2021 i3d') == ['Copyright (c) 2021 i3d']
    assert copyrights('Copyright (c) 2026 Zacess <https://zacess.com>') == ['Copyright (c) 2026 Zacess <https://zacess.com>']
    assert copyrights('Copyright © 2026\n') == []
    assert copyrights('Copyright [yyyy] [name of copyright owner]') == []
    assert copyrights('The above copyright notice and this permission notice shall be included') == []
    up = Upstream.__new__(Upstream)
    up.pins, up.used = {}, set()
    assert up.pin('github.com/a/b', lambda: None) is None and up.pins == {} and up.used == set()
    assert up.pin('github.com/a/b', lambda: 'abc') == 'abc' and up.pins == {'github.com/a/b': 'abc'}
    print('ok')


if __name__ == '__main__':
    check() if sys.argv[1:] == ['--check'] else main(sys.argv[1])
