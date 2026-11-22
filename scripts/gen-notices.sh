#!/bin/sh
# Generates licenses/THIRD_PARTY_LICENSES_{RUST,NPM}.md from the two Cargo.lock closures (root workspace and
# app/src-tauri) and the web/ pnpm prod dependencies. Offline: needs the cargo registry sources and web/node_modules
# (`pnpm install --offline --frozen-lockfile --ignore-scripts`; pnpm reads licence data from the installed tree).
#   gen-notices.sh              write licenses/*.md
#   gen-notices.sh --check      regenerate under .scratch/ and diff against licenses/ (scripts/check-app.sh)
#   gen-notices.sh --selftest   the licence gate: OR needs one passing branch, AND every branch, GPL/LGPL alone, empty,
#                               unknown ids and unparseable expressions are rejected; a crate without licence text is caught
# Crates whose source ships no licence file get the upstream text from licenses/supplement/<crate>/LICENSE*.
#   gen-notices.sh --gate EXPR  exit non-zero when EXPR fails the licence gate
# The notices come from `license` fields and licence files in the package sources; this does not prove that a
# licence file matches its declared SPDX id, and it is not legal advice.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
unset CARGO_TARGET_DIR
mkdir -p "$ROOT/.scratch"
exec python3 -I - "$ROOT" "$@" <<'PY'
import difflib, json, os, re, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(sys.argv[1])
ARGS = sys.argv[2:]
TARGET = 'aarch64-apple-darwin'  # the shipped app is a macOS arm64 build; other-OS crates are not in the closure
CARGO_DIRS = ['.', 'app/src-tauri']
FILE_RE = re.compile(r'^(licen[cs]e|copying|copyright|unlicense|notice)', re.I)
SKIP_SUFFIX = {'.rs', '.toml', '.json', '.js', '.ts', '.py', '.sh', '.lock'}


# Ids the gate accepts; GPL, LGPL, AGPL, SSPL, NC and anything not listed fail. Add an id here after reading its licence.
ALLOWED = {'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Zlib', 'Unlicense', 'CC0-1.0', 'MPL-2.0',
           'Unicode-3.0', 'Unicode-DFS-2016', 'BSL-1.0'}
TOKEN_RE = re.compile(r'\(|\)|/|[^\s()/]+')


def spdx_ok(expr):
    """True when the SPDX expression passes: OR needs one passing branch, AND every branch; `/` reads as OR (old crates.io style).
    Raises ValueError on a syntax error."""
    toks = TOKEN_RE.findall(expr)
    pos = 0

    def peek():
        return toks[pos] if pos < len(toks) else None

    def take():
        nonlocal pos
        pos += 1
        return toks[pos - 1]

    def atom():
        t = peek()
        if t is None or t in (')', 'OR', 'AND', 'WITH', '/'):
            raise ValueError(f'unexpected {t!r}')
        take()
        if t == '(':
            v = or_expr()
            if peek() != ')':
                raise ValueError('missing )')
            take()
            return v
        if peek() == 'WITH':
            take()
            if peek() in (None, ')', 'OR', 'AND', '/'):
                raise ValueError('WITH needs an exception id')
            take()
        return t in ALLOWED

    def and_expr():
        v = atom()
        while peek() == 'AND':
            take()
            v = atom() and v
        return v

    def or_expr():
        v = and_expr()
        while peek() in ('OR', '/'):
            take()
            v = and_expr() or v
        return v

    v = or_expr()
    if pos != len(toks):
        raise ValueError(f'unexpected {toks[pos]!r}')
    return v


def gate(name, expr):
    """Return a refusal reason or None."""
    if not expr or not expr.strip():
        return f'{name}: no licence expression'
    try:
        if spdx_ok(expr):
            return None
    except ValueError as e:
        return f'{name}: unparseable licence expression "{expr}" ({e})'
    return f'{name}: no branch of the licence expression "{expr}" passes the gate (copyleft, non-commercial or unknown id)'


def enforce(pkgs):
    bad = [r for p in pkgs if (r := gate(f"{p['name']} {p['version']}", p['license']))]
    if bad:
        sys.exit('gen-notices: licence gate failed:\n  ' + '\n  '.join(bad))


def notices_have_text_for_every_crate(pkgs):
    """Names of packages listed with a licence expression but no licence text (source file or licenses/supplement/)."""
    return [f"{p['name']} {p['version']}" for p in pkgs if p['license'].strip() and not p['files']]


def selftest():
    # OR needs one passing branch, AND needs every branch; a bare GPL/LGPL, an empty or unparseable expression is rejected.
    cases = [('GPL-3.0-only', False), ('', False), ('GPL', False), ('LGPL', False), ('Foo-1.0', False), ('MIT OR', False), ('(MIT OR Apache-2.0', False),
             ('MIT OR GPL-3.0-only', True), ('Apache-2.0 OR LGPL-2.1-or-later', True), ('MIT OR LGPL-2.1-or-later', True),
             ('GPL-3.0-only OR LGPL-2.1-only', False), ('MIT AND GPL-3.0-only', False), ('MIT AND Apache-2.0', True),
             ('(MIT OR Apache-2.0) AND BSD-3-Clause', True), ('(MIT OR GPL-2.0-only) AND GPL-3.0-only', False), ('MIT OR Apache-2.0', True),
             ('MIT/Apache-2.0', True), ('Zlib OR Apache-2.0 OR MIT', True), ('MIT WITH LLVM-exception', True)]
    wrong = [e for e, want in cases if (gate('fake 1.0.0', e) is None) != want]
    ok = not wrong
    if wrong:
        print('selftest: wrong verdict for', wrong)
    fake = {'name': 'fake-no-text', 'version': '1.0.0', 'license': 'MIT', 'files': []}
    ok = ok and notices_have_text_for_every_crate([fake]) == ['fake-no-text 1.0.0'] and not notices_have_text_for_every_crate([{**fake, 'files': [('LICENSE', 'x')]}])
    print('selftest:', f'{len(cases)} gate cases and the missing-text check passed' if ok else 'FAILED')
    sys.exit(0 if ok else 1)


def licence_files(d, extra=None):
    """(filename, normalised text) for the licence and NOTICE files at the top of a package directory."""
    if not d.is_dir():
        return []
    names = sorted(f.name for f in d.iterdir() if f.is_file() and FILE_RE.match(f.name) and f.suffix.lower() not in SKIP_SUFFIX)
    if extra and (d / extra).is_file() and extra not in names:
        names.append(extra)
    out = []
    for n in names:
        t = (d / n).read_bytes().decode('utf-8', 'replace').replace('\r\n', '\n')
        t = '\n'.join(line.rstrip() for line in t.split('\n')).strip('\n')
        if t:
            out.append((n, t))
    return out


def rust_closure(rel):
    cwd = ROOT / rel
    run = lambda *a: subprocess.run(a, cwd=cwd, check=True, capture_output=True, text=True).stdout
    meta = json.loads(run('cargo', 'metadata', '--locked', '--offline', '--format-version', '1'))
    tree = run('cargo', 'tree', '--locked', '--offline', '--workspace', '-e', 'normal', '--target', TARGET, '--prefix', 'none', '--format', '{p}')
    shipped = {m.groups() for line in tree.splitlines() if (m := re.match(r'(\S+) v(\S+)', line))}
    third = {(p['name'], p['version']): p for p in meta['packages'] if (p.get('source') or '').startswith('registry+')}
    local_hits = [k for k in shipped if k not in third and not k[0].startswith('nunchiro')]
    if local_hits:
        sys.exit(f'gen-notices: non-crates.io package in the closure of {rel}: {sorted(local_hits)}')
    return {k: third[k] for k in shipped if k in third}, len(third)


def fence(t):
    return '`' * max(3, max((len(m) for m in re.findall(r'`+', t)), default=0) + 1)


def render(title, intro, pkgs, notes):
    """pkgs: list of dict(name, version, license, source, files[(filename, text)]); identical texts are listed once."""
    pkgs = sorted(pkgs, key=lambda p: (p['name'], p['version']))
    groups, none = {}, []
    for p in pkgs:
        if not p['files']:
            none.append(p)
        for n, t in p['files']:
            groups.setdefault(t, []).append((p, n))
    ordered = sorted(groups.items(), key=lambda kv: (kv[1][0][0]['name'], kv[1][0][0]['version']))
    out = [f'# {title}\n', intro.strip() + '\n']
    out += [n.strip() + '\n' for n in notes]
    out.append(f'{len(pkgs)} packages, {len(ordered)} distinct licence and notice texts, {len(none)} packages without a licence file in the source.\n')
    out.append('## Packages\n')
    out += [f"- {p['name']} {p['version']} ({p['license']}){' <' + p['source'] + '>' if p['source'] else ''}" for p in pkgs]
    out.append('\n## Packages without a licence file in the source\n')
    out += [f"- {p['name']} {p['version']}: {p['license']}; no licence file in the crate source" for p in none] or ['- none']
    out.append(f'\nCount: {len(none)}\n')
    out.append('## Licence and notice texts\n')
    for i, (t, who) in enumerate(ordered, 1):
        names = sorted({n for _, n in who})
        out.append(f"### Text {i}: {', '.join(names)}\n")
        out.append('Used by: ' + ', '.join(sorted({f"{p['name']} {p['version']}" for p, _ in who})) + '\n')
        f = fence(t)
        out.append(f'{f}text\n{t}\n{f}\n')
    return '\n'.join(out)


def rust_file():
    union, per = {}, []
    for rel in CARGO_DIRS:
        closure, allthird = rust_closure(rel)
        per.append((rel, len(closure), allthird))
        union.update(closure)
    pkgs = []
    for (name, ver), p in union.items():
        d = Path(p['manifest_path']).parent
        pkgs.append({'name': name, 'version': ver, 'license': p.get('license') or '', 'source': p.get('repository') or '',
                     'files': licence_files(d, p.get('license_file')) or licence_files(ROOT / 'licenses' / 'supplement' / name)})
    enforce(pkgs)
    if missing := notices_have_text_for_every_crate(pkgs):
        sys.exit('gen-notices: crates without licence text (add licenses/supplement/<name>/LICENSE*):\n  ' + '\n  '.join(missing))
    counts = '; '.join(f'`{rel}`: {n} crates.io packages in the shipped closure ({a} in the whole lock file)' for rel, n, a in per)
    notes = [
        f'Closure: normal dependencies for `{TARGET}` (`cargo tree -e normal`), so build-only crates are left out. Proc-macro crates are normal edges and stay in, so the list is an upper bound of what is linked. {counts}. Packages shared by both lock files are listed once ({len(pkgs)} in total).',
        'Elections: where a package offers `Unlicense OR MIT`, Nunchiro takes MIT. For `MIT OR Apache-2.0` and similar the package texts of both are kept below.',
        'MPL-2.0 crates (cssparser, cssparser-macros, dtoa-short, selectors, option-ext) are used as unmodified crates.io releases; their MPL-2.0 is file-level, and the source of each is at https://crates.io/crates/<name>/<version>.',
    ]
    return render('Third-party licenses: Rust crates', 'Licence and NOTICE files of the crates.io packages linked into Nunchiro (`core` workspace and the `app/src-tauri` Tauri shell). Generated by `scripts/gen-notices.sh`; do not edit by hand.', pkgs, notes)


def npm_file():
    web = ROOT / 'web'
    data = json.loads(subprocess.run(['pnpm', 'licenses', 'list', '--prod', '--json'], cwd=web, check=True, capture_output=True, text=True).stdout)
    pkgs, shiki = [], []
    for lic, entries in data.items():
        for e in entries:
            for ver, path in zip(e['versions'], e['paths']):
                d = Path(path)
                pkgs.append({'name': e['name'], 'version': ver, 'license': e.get('license') or lic, 'source': e.get('homepage') or '',
                             'files': licence_files(d)})
                if e['name'] in ('@shikijs/langs', '@shikijs/themes'):
                    shiki.append((e['name'], ver, sum(1 for f in (d / 'dist').glob('*.mjs') if f.name != 'index.mjs')))
    enforce(pkgs)
    shiki.sort()
    kinds = ', '.join(f'{n} {v} ({c} modules)' for n, v, c in shiki)
    notes = [
        f'Packages: `pnpm licenses list --prod` in `web/` ({len({p["name"] for p in pkgs})} package names, {len(pkgs)} name and version pairs; `app/` has only dev dependencies and ships nothing from npm).',
        '## Shiki grammars and themes\n\n'
        f'`web/dist` carries TextMate grammar and theme chunks from {kinds}. Those packages are MIT (their own LICENSE is below), '
        'but each grammar and theme is derived from an upstream project with its own licence. '
        'The upstream licence list is not in the installed package: the `@shikijs/langs` and `@shikijs/themes` 4.5.0 tarballs carry no per-grammar licence '
        'metadata, no `tm-grammars` or `tm-themes` package is installed, and the chunks have no licence headers. '
        'It was therefore not possible to confirm from the install that every upstream grammar and theme is permissive. '
        'Follow-up: list the upstream licences from the `tm-grammars` and `tm-themes` metadata, or narrow the bundled languages and themes in `web/src/files/highlight.ts`.',
    ]
    return render('Third-party licenses: npm packages', 'Licence and NOTICE files of the npm packages bundled into the Nunchiro web UI. Generated by `scripts/gen-notices.sh`; do not edit by hand.', pkgs, notes)


def generate(out):
    out.mkdir(parents=True, exist_ok=True)
    files = {'THIRD_PARTY_LICENSES_RUST.md': rust_file(), 'THIRD_PARTY_LICENSES_NPM.md': npm_file()}
    for n, t in files.items():
        if not t.strip():
            sys.exit(f'gen-notices: {n} is empty')
        (out / n).write_text(t, encoding='utf-8')
    return files


if ARGS[:1] == ['--selftest']:
    selftest()
elif ARGS[:1] == ['--gate']:
    r = gate('arg', ARGS[1] if len(ARGS) > 1 else '')
    print(r or 'accepted')
    sys.exit(1 if r else 0)
elif ARGS[:1] == ['--check']:
    tmp = ROOT / '.scratch' / 'gen-notices-check'
    shutil.rmtree(tmp, ignore_errors=True)
    new = generate(tmp)
    bad = False
    for n, t in new.items():
        f = ROOT / 'licenses' / n
        old = f.read_text(encoding='utf-8') if f.is_file() else ''
        if old != t:
            bad = True
            sys.stdout.writelines(list(difflib.unified_diff(old.splitlines(True), t.splitlines(True), f'licenses/{n}', 'regenerated', n=1))[:60])
    print('gen-notices: licenses/ differs from a fresh run; run scripts/gen-notices.sh' if bad else 'gen-notices: licenses/ is up to date')
    sys.exit(1 if bad else 0)
elif not ARGS:
    generate(ROOT / 'licenses')
else:
    sys.exit('usage: gen-notices.sh [--check|--selftest|--gate EXPR]')
PY
