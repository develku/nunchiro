#!/bin/sh
# Weekly dependency and supply-chain check (ticket 1124). Runs outside the merge gate; development is local only, so
# no GitHub Dependabot. Writes .scratch/supply-chain/report-<date>.md and, beside it, the standard SBOMs (CycloneDX JSON).
#   supply-chain.sh                    run every check, write the report and the SBOMs
#   supply-chain.sh --weekly           the scheduled run: registry reads only (audits, outdated), no SBOM, no download
#   supply-chain.sh --selftest         check the CVSS 3 scoring, the exit rule, the log line and the npm SBOM walk (offline)
#   supply-chain.sh --sbom <dir>       only the SBOMs, into <dir>, then --sbom-check (scripts/build-release.sh)
#   supply-chain.sh --sbom-check <dir> exit 1 unless <dir> holds exactly the release set: one valid CycloneDX document
#                                      with components per shipped crate (each tracked Cargo.toml with [package]) and npm
# What it runs, for both Cargo workspaces (Cargo.toml and app/src-tauri/Cargo.toml) and the pnpm workspace:
#   cargo audit       RustSec advisories; the advisory database is cloned to .scratch/supply-chain/advisory-db (GitHub)
#   cargo deny        check licenses bans sources with deny.toml (advisories come from cargo audit only)
#   cargo tree and cargo deny run --offline --locked: they read the local Cargo cache and never download crates;
#   a missing crate source is reported (run cargo fetch --locked once by hand)
#   pnpm audit        all packages and --prod; sends package names and versions to the npm registry
#   pnpm outdated -r  needs node_modules; when it is missing the report says so (this script never installs)
#   cargo outdated    only when installed (cargo install --locked cargo-outdated@0.19.0: 0.20 needs rustc 1.98); asks crates.io
#   cargo cyclonedx   Rust SBOM per crate, for aarch64-apple-darwin
#   pnpm list         npm SBOM: the installed production packages (pnpm list -r --prod --depth Infinity), written as
#                     CycloneDX here. Ticket 1130 security review: no SBOM tool is fetched at run time (it was npx cdxgen);
#                     pnpm is the pinned packageManager that already runs the build, so no new code runs
# --weekly skips both SBOM steps: the owner approved only registry reads that send the package list (pnpm audit,
# RustSec, pnpm outdated, cargo outdated) for the unattended run. The release makes its SBOM per release (B2).
# Needs cargo-audit, cargo-deny and cargo-cyclonedx (cargo install --locked <name>) and pnpm.
# Exit: 1 when a high or critical vulnerability is in a shipped dependency (Rust: in cargo tree -e normal,build for
# aarch64-apple-darwin; npm: in pnpm audit --prod); 2 when cargo audit or pnpm audit could not run (an audit that did
# not run is not a pass); 0 otherwise. Licence, ban, source, outdated and unmaintained results are in the report only.
# shortcut: a RustSec advisory without a CVSS 3 vector (none, or CVSS 4) is "unrated" and never fails the run; read
# those in the report. Upgrade when RustSec moves to CVSS 4 vectors.
#
# Weekly schedule (the lead installs it; this script installs nothing): the LaunchAgent template
# scripts/launchd/com.me.nunchiro-supply-chain.plist (Monday 04:30, log in .scratch/supply-chain/launchd.log):
#   mkdir -p <checkout>/.scratch/supply-chain   # launchd does not make the log folder
#   sed "s#__REPO__#<checkout>#g; s#__HOME__#$HOME#g" scripts/launchd/com.me.nunchiro-supply-chain.plist \
#     > ~/Library/LaunchAgents/com.me.nunchiro-supply-chain.plist
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.me.nunchiro-supply-chain.plist
# Each run prints one line for docs/release/supply-chain-log.md (also at the end of the report); the lead appends it
# there in the record step, so a reader of the main line sees that outdated packages are tracked.
# A scheduled step can run it the same way and read the exit code: 1 = file a ticket per finding the report
# lists as blocking, 2 = rerun when the network is back. __REPO__ should be a checkout of the current main line.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
unset CARGO_TARGET_DIR
exec python3 -I - "$ROOT" "$@" <<'PY'
import datetime, json, os, re, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(sys.argv[1])
ARGS = sys.argv[2:]
WEEKLY = ARGS == ['--weekly']
OUT = ROOT / '.scratch' / 'supply-chain'
TARGET = 'aarch64-apple-darwin'  # the shipped CLI and app are macOS arm64 builds
MANIFESTS = ['Cargo.toml', 'app/src-tauri/Cargo.toml']
SEVERITIES = ['critical', 'high', 'medium', 'low', 'unrated']
BLOCKING = {'critical', 'high'}
LOG = 'docs/release/supply-chain-log.md'
COUNTS = {}  # outdated counts by ecosystem, set by outdated(); a missing key = did not run

W = {'AV': {'N': .85, 'A': .62, 'L': .55, 'P': .2}, 'AC': {'L': .77, 'H': .44}, 'UI': {'N': .85, 'R': .62},
     'CIA': {'H': .56, 'L': .22, 'N': 0}}


def roundup(x):
    i = round(x * 100000)
    return i / 100000.0 if i % 10000 == 0 else (i // 10000 + 1) / 10.0


def cvss3(vector):
    """CVSS 3.0/3.1 base score from a vector string (FIRST specification, section 7)."""
    m = dict(p.split(':') for p in vector.split('/')[1:])
    changed = m['S'] == 'C'
    pr = {'N': .85, 'L': .68 if changed else .62, 'H': .5 if changed else .27}[m['PR']]
    iss = 1 - (1 - W['CIA'][m['C']]) * (1 - W['CIA'][m['I']]) * (1 - W['CIA'][m['A']])
    impact = 7.52 * (iss - .029) - 3.25 * (iss - .02) ** 15 if changed else 6.42 * iss
    if impact <= 0:
        return 0.0
    exploit = 8.22 * W['AV'][m['AV']] * W['AC'][m['AC']] * pr * W['UI'][m['UI']]
    return roundup(min((1.08 if changed else 1) * (impact + exploit), 10))


def severity(vector):
    if not vector or not vector.startswith('CVSS:3.'):
        return 'unrated', None
    s = cvss3(vector)
    return ('critical' if s >= 9 else 'high' if s >= 7 else 'medium' if s >= 4 else 'low'), s


def blocking(findings):
    return [f for f in findings if f['kind'] == 'vulnerability' and f['shipped'] and f['severity'] in BLOCKING]


def log_line(day, commit, code, vulns, warns, counts):
    """One row of LOG: date, commit, exit, vulnerabilities per severity (Rust, npm), Rust warnings, outdated counts."""
    sev = lambda eco: '/'.join(str(sum(f['eco'] == eco and f['severity'] == s for f in vulns)) for s in SEVERITIES)
    old = lambda eco: str(counts[eco]) if eco in counts else 'not run'
    return f"| {day} | {commit} | {code} | {sev('Rust')} | {sev('npm')} | {len(warns)} | {old('npm')} | {old('rust')} | - |"


def selftest():
    assert cvss3('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H') == 9.8
    assert cvss3('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:H/A:N') == 6.5
    assert cvss3('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N') == 6.1
    assert cvss3('CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:N') == 0.0
    assert severity('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N') == ('unrated', None)
    assert severity(None) == ('unrated', None)
    f = lambda sev, shipped, kind='vulnerability': dict(severity=sev, shipped=shipped, kind=kind)
    assert blocking([f('high', True), f('critical', False), f('medium', True), f('high', True, 'unsound')]) == [f('high', True)]
    tree = [{'name': 'web', 'dependencies': {
        '@scope/a': {'version': '1.0.0', 'dependencies': {'b': {'version': '2.0.0'}}},
        'b': {'version': '2.0.0', 'deduped': True}, 'w': {'version': 'link:../w'}}}]
    assert [c['purl'] for c in npm_components(tree)] == ['pkg:npm/%40scope/a@1.0.0', 'pkg:npm/b@2.0.0']
    v = [dict(eco='Rust', severity='medium'), dict(eco='npm', severity='low'), dict(eco='Rust', severity='unrated')]
    row = log_line('2026-11-25', '8f4cac357', 0, v, [{}] * 8, {'npm': 15})
    assert row == '| 2026-11-25 | 8f4cac357 | 0 | 0/0/1/0/1 | 0/0/0/1/0 | 8 | 15 | not run | - |', row
    print('supply-chain selftest: log line ' + row)
    print('supply-chain selftest: ok')


def run(cmd, cwd=ROOT, env=None):
    p = subprocess.run(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return p.returncode, p.stdout, p.stderr


def have(*cmd):
    try:
        return run(list(cmd))[0] == 0
    except FileNotFoundError:
        return False


def tail(text, n=3):
    return ' / '.join(l.strip() for l in text.strip().splitlines()[-n:])


def shipped_crates(manifest):
    # --offline: a crate source missing from the Cargo cache is reported, never fetched (not an approved read)
    rc, out, err = run(['cargo', 'tree', '--locked', '--offline', '--workspace', '-e', 'normal,build', '--target', TARGET,
                        '--prefix', 'none', '-f', '{p}', '--manifest-path', manifest])
    if rc:
        raise RuntimeError('cargo tree --offline (crate sources missing? run cargo fetch --locked once): ' + tail(err))
    return {tuple(l.split()[:2]) for l in out.splitlines() if l.strip()}


def cargo_audit(findings, missing):
    db = OUT / 'advisory-db'
    for i, manifest in enumerate(MANIFESTS):
        lock = str(Path(manifest).parent / 'Cargo.lock')
        cmd = ['cargo', 'audit', '--db', str(db), '--json', '-f', lock] + (['--no-fetch'] if i else [])
        rc, out, err = run(cmd)
        try:
            data = json.loads(out)
            ship = shipped_crates(manifest)
        except (ValueError, RuntimeError) as e:
            missing.append(f'cargo audit {lock}: {e if isinstance(e, RuntimeError) else tail(err)}')
            continue
        items = [('vulnerability', v) for v in data['vulnerabilities']['list']]
        items += [(kind, w) for kind, ws in data.get('warnings', {}).items() for w in ws]
        for kind, v in items:
            a, pkg = v.get('advisory') or {}, v['package']
            sev, score = severity(a.get('cvss')) if kind == 'vulnerability' else ('warning', None)
            findings.append(dict(eco='Rust', lock=lock, kind=kind, package=pkg['name'], version=pkg['version'],
                                 id=a.get('id') or '-', severity=sev, score=score, title=a.get('title') or kind,
                                 fix=', '.join((v.get('versions') or {}).get('patched') or []) or 'none',
                                 shipped=(pkg['name'], 'v' + pkg['version']) in ship))


def pnpm_audit(findings, missing):
    runs = {}
    for flag in ([], ['--prod']):
        rc, out, err = run(['pnpm', 'audit', '--json'] + flag)
        try:
            runs[bool(flag)] = json.loads(out)['advisories']
        except (ValueError, KeyError):
            missing.append('pnpm audit ' + ' '.join(flag) + ': ' + tail(out + err))
            return
    for key, a in runs[False].items():
        sev = {'moderate': 'medium', 'info': 'low'}.get(a['severity'], a['severity'])
        for version in sorted({x['version'] for x in a['findings']}):
            findings.append(dict(eco='npm', lock='pnpm-lock.yaml', kind='vulnerability', package=a['module_name'],
                                 version=version, id=a.get('github_advisory_id') or str(a['id']), severity=sev,
                                 score=(a.get('cvss') or {}).get('score') or None, title=a['title'],
                                 fix=a.get('patched_versions') or 'none', shipped=key in runs[True]))


def cargo_deny():
    rows = []
    for manifest in MANIFESTS:
        rc, out, err = run(['cargo', 'deny', '--offline', '--locked', '--manifest-path', manifest, '--config', 'deny.toml',
                            'check', 'licenses', 'bans', 'sources'])
        (OUT / f'deny-{Path(manifest).parts[0] if "/" in manifest else "root"}.txt').write_text(out + err)
        rows.append((manifest, 'ok' if rc == 0 else f'FAILED (exit {rc})', tail(out + err, 1)))
    return rows


def outdated():
    lines = []
    if not (ROOT / 'node_modules').exists():
        # no install here: it fetches packages, which the weekly run is not approved to do
        lines.append('node_modules is missing, so pnpm outdated has no installed versions; run pnpm install once.')
    rc, out, err = run(['pnpm', 'outdated', '-r', '--format', 'json'])
    try:
        data = json.loads(out or '{}')
        rows = sorted((n, d.get('current', '?'), d.get('wanted', '?'), d.get('latest', '?'), d.get('dependencyType', ''))
                      for n, d in data.items())
        COUNTS['npm'] = len(rows)
        lines += ['### npm (pnpm outdated -r)', '', f'{len(rows)} outdated.', '']
        if rows:
            lines += ['| Package | Current | Wanted | Latest | Type |', '|---|---|---|---|---|']
            lines += ['| ' + ' | '.join(r) + ' |' for r in rows]
    except ValueError:
        lines += ['### npm (pnpm outdated -r)', '', 'Did not run: ' + tail(out + err)]
    lines += ['', '### Rust (cargo outdated)', '']
    if not have('cargo', 'outdated', '--version'):
        return lines + ['Not installed. Install with: cargo install --locked cargo-outdated@0.19.0 (0.20 needs rustc 1.98)']
    for manifest in MANIFESTS:
        rc, out, err = run(['cargo', 'outdated', '--manifest-path', manifest, '--workspace', '--root-deps-only',
                            '--format', 'json'])
        rows = set()
        for l in out.splitlines():
            try:
                for d in json.loads(l).get('dependencies', []):
                    rows.add((d['name'], d['project'], d['compat'], d['latest'], d.get('kind') or ''))
            except ValueError:
                pass
        COUNTS['rust'] = COUNTS.get('rust', 0) + len(rows)
        lines += [f'{manifest}: {len(rows)} outdated.' + ('' if rc == 0 else ' Exit ' + str(rc) + ': ' + tail(err)), '']
        if rows:
            lines += ['| Crate | Current | Compatible | Latest | Kind |', '|---|---|---|---|---|']
            lines += ['| ' + ' | '.join(r) + ' |' for r in sorted(rows)] + ['']
    return lines


def sbom_name(crate_dir):
    return f'sbom-rust-{"app" if crate_dir.name == "src-tauri" else crate_dir.name}.cdx.json'


class InventoryError(Exception):
    pass


def tracked_manifests():
    # A failed or empty inventory must stop a release, not shrink the required SBOM set (security review 1130).
    rc, out, err = run(['git', 'ls-files', 'Cargo.toml', '*/Cargo.toml'])
    if rc or not out.split():
        raise InventoryError('git ls-files Cargo.toml: ' + (f'exit {rc}: ' + tail(err) if rc else 'no tracked manifest'))
    return out.split()


def expected_sboms():
    """The release set: one Rust SBOM per tracked crate with a [package] (a bare workspace has none) and the npm one."""
    crates = [Path(m).parent for m in tracked_manifests()
              if re.search(r'^\[package\]', (ROOT / m).read_text(), re.M)]
    if not crates:
        raise InventoryError('git ls-files Cargo.toml: no tracked crate with a [package]')
    return sorted([sbom_name(ROOT / d) for d in crates] + ['sbom-npm.cdx.json'])


def check_sboms(folder):
    want, have = set(expected_sboms()), {f.name for f in folder.glob('sbom-*.cdx.json')}
    notes = [f'{n}: missing' for n in sorted(want - have)] + [f'{n}: not in the release set' for n in sorted(have - want)]
    for n in sorted(want & have):
        try:
            d = json.loads((folder / n).read_text())
        except ValueError:
            d = None
        if not isinstance(d, dict) or d.get('bomFormat') != 'CycloneDX' or not d.get('components'):
            notes.append(f'{n}: not a CycloneDX document with components')
    return notes


def npm_purl(name, version):
    return 'pkg:npm/' + ('%40' + name[1:] if name.startswith('@') else name) + '@' + version


def npm_components(projects):
    """Every installed package of pnpm list --json (deduped entries recur in full elsewhere); workspace links skipped."""
    seen = set()

    def walk(deps):
        for name, d in (deps or {}).items():
            v = d.get('version') or ''
            if v and not v.startswith(('link:', 'file:', 'workspace:')):
                seen.add((name, v))
            walk(d.get('dependencies'))
            walk(d.get('optionalDependencies'))
    for p in projects:
        walk(p.get('dependencies'))
        walk(p.get('optionalDependencies'))
    return [{'type': 'library', 'name': n, 'version': v, 'purl': npm_purl(n, v), 'bom-ref': npm_purl(n, v)}
            for n, v in sorted(seen)]


def npm_sbom(dest):
    rc, out, err = run(['pnpm', 'list', '-r', '--prod', '--json', '--depth', 'Infinity'])
    if rc:
        return 'pnpm list: ' + tail(out + err)
    try:
        components = npm_components(json.loads(out))
    except (ValueError, AttributeError) as e:
        return f'pnpm list: unreadable output ({e})'
    rc, version, err = run(['pnpm', '--version'])
    version = version.strip()
    if rc or not version:
        return 'pnpm --version: ' + (f'exit {rc}: ' if rc else 'empty output: ') + tail(err)
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    dest.write_text(json.dumps({'bomFormat': 'CycloneDX', 'specVersion': '1.6', 'version': 1, 'metadata': {
        'timestamp': now, 'tools': {'components': [{'type': 'application', 'name': 'pnpm', 'version': version}]}},
        'components': components}, indent=1))
    return None


def sbom(folder=OUT):
    made, notes = [], []
    for manifest in MANIFESTS:
        rc, out, err = run(['cargo', 'cyclonedx', '--manifest-path', manifest, '-f', 'json', '--spec-version', '1.6',
                            '--target', TARGET, '--override-filename', 'supply-chain-sbom', '-q'])
        if rc:
            notes.append(f'cargo cyclonedx {manifest}: ' + tail(err))
    # cargo cyclonedx writes beside each crate's Cargo.toml; move them out of the tree
    for f in [ROOT / Path(m).parent / 'supply-chain-sbom.json' for m in tracked_manifests()]:
        if not f.exists():
            continue
        dest = folder / sbom_name(f.parent)
        shutil.move(str(f), dest)
        made.append(dest)
    dest = folder / 'sbom-npm.cdx.json'
    note = npm_sbom(dest)
    if note:
        notes.append(note)
    else:
        made.append(dest)
    rows = []
    for f in made:
        try:
            rows.append((f, len(json.loads(f.read_text()).get('components', []))))
        except ValueError:
            notes.append(f'{f.name}: not valid JSON')
    return rows, notes


def cell(s):
    return str(s).replace('|', '\\|').replace('\n', ' ')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    findings, missing = [], []
    for tool in ('audit', 'deny', 'cyclonedx'):
        if not have('cargo', tool, '--version'):
            missing.append(f'cargo {tool} not installed: cargo install --locked cargo-{tool}')
    if not any(m.startswith('cargo audit') for m in missing):
        cargo_audit(findings, missing)
    pnpm_audit(findings, missing)
    deny = cargo_deny() if have('cargo', 'deny', '--version') else []
    old = outdated()
    if WEEKLY:
        sboms, sbom_notes = [], ['skipped in the weekly run (--weekly); the release makes its SBOM']
    else:
        try:
            sboms, sbom_notes = sbom() if have('cargo', 'cyclonedx', '--version') else ([], ['cargo cyclonedx not installed'])
        except InventoryError as e:
            sboms, sbom_notes = [], [str(e)]

    vulns = [f for f in findings if f['kind'] == 'vulnerability']
    warns = [f for f in findings if f['kind'] != 'vulnerability']
    block = blocking(findings)
    audit_missing = [m for m in missing if 'audit' in m]
    code = 1 if block else 2 if audit_missing else 0
    today = datetime.date.today().isoformat()
    L = [f'# Supply-chain report {today}', '',
         f'Exit {code}: ' + ('high or critical vulnerability in a shipped dependency' if code == 1 else
                             'an audit did not run' if code == 2 else 'no high or critical vulnerability in a shipped dependency'),
         '', '## Vulnerabilities by severity', '',
         '| Ecosystem | ' + ' | '.join(SEVERITIES) + ' | shipped high+critical |', '|---' * (len(SEVERITIES) + 2) + '|']
    for eco in ('Rust', 'npm'):
        mine = [f for f in vulns if f['eco'] == eco]
        L.append(f'| {eco} | ' + ' | '.join(str(sum(f['severity'] == s for f in mine)) for s in SEVERITIES)
                 + f' | {len(blocking(mine))} |')
    L += ['', 'Rust: cargo audit on both Cargo.lock files; npm: pnpm audit on pnpm-lock.yaml. "Shipped" = in the '
          'release closure (Rust: cargo tree -e normal,build for ' + TARGET + '; npm: pnpm audit --prod).', '']
    if vulns:
        L += ['| Severity | Ecosystem | Package | Version | Advisory | Fix | Shipped | Lockfile | Title |', '|---' * 9 + '|']
        for f in sorted(vulns, key=lambda f: (SEVERITIES.index(f['severity']), f['eco'], f['package'])):
            sev = f['severity'] + (f' ({f["score"]})' if f['score'] is not None else '')
            L.append('| ' + ' | '.join(cell(x) for x in (sev, f['eco'], f['package'], f['version'], f['id'], f['fix'],
                                                          'yes' if f['shipped'] else 'no', f['lock'], f['title'])) + ' |')
    L += ['', f'## Rust warnings (unmaintained, unsound, yanked): {len(warns)}', '']
    if warns:
        L += ['| Kind | Package | Version | Advisory | Shipped | Lockfile | Title |', '|---' * 7 + '|']
        for f in sorted(warns, key=lambda f: (f['kind'], f['package'])):
            L.append('| ' + ' | '.join(cell(x) for x in (f['kind'], f['package'], f['version'], f['id'],
                                                          'yes' if f['shipped'] else 'no', f['lock'], f['title'])) + ' |')
    L += ['', '## Policy (cargo deny check licenses bans sources, deny.toml)', '']
    L += [f'- {m}: {s} ({t})' for m, s, t in deny] or ['- did not run (cargo deny not installed)']
    L += ['', '## Outdated', ''] + old
    L += ['', '## SBOM (CycloneDX 1.6 JSON)', '']
    L += [f'- .scratch/supply-chain/{f.name}: {n} components' for f, n in sboms] + [f'- {n}' for n in sbom_notes]
    L += ['', '## Checks that did not run', ''] + ([f'- {m}' for m in missing] or ['- none'])
    commit = run(['git', 'rev-parse', '--short=9', 'HEAD'])[1].strip() or '?'
    row = log_line(today, commit, code, vulns, warns, COUNTS)
    L += ['', f'## Line for {LOG}', '', row]
    report = OUT / f'report-{today}.md'
    report.write_text('\n'.join(L) + '\n')
    print(f'supply-chain: {report} (exit {code}; {len(vulns)} vulnerabilities, {len(block)} blocking)')
    print(f'supply-chain: line for {LOG}: {row}')
    for f in block:
        print(f'  BLOCKING {f["eco"]} {f["package"]} {f["version"]} {f["id"]} {f["severity"]} fix {f["fix"]}')
    return code


if __name__ == '__main__':
    if ARGS == ['--selftest']:
        selftest()
        sys.exit(0)
    if len(ARGS) == 2 and ARGS[0] in ('--sbom', '--sbom-check'):
        # A release carries its full SBOM set: a missing tool, a failed step, or a missing or invalid file fails the call.
        folder = Path(ARGS[1]).resolve()
        notes = []
        if ARGS[0] == '--sbom':
            if not have('cargo', 'cyclonedx', '--version'):
                sys.exit('supply-chain: cargo cyclonedx not installed: cargo install --locked cargo-cyclonedx')
            folder.mkdir(parents=True, exist_ok=True)
        try:
            if ARGS[0] == '--sbom':
                rows, notes = sbom(folder)
                for f, n in rows:
                    print(f'supply-chain: {f} ({n} components)')
            notes += check_sboms(folder) if folder.is_dir() else [f'{folder}: no such folder']
        except InventoryError as e:
            notes.append(str(e))
        for n in notes:
            print('supply-chain: ' + n, file=sys.stderr)
        sys.exit(1 if notes else 0)
    if ARGS and not WEEKLY:
        sys.exit('usage: supply-chain.sh [--weekly | --selftest | --sbom <dir> | --sbom-check <dir>]')
    sys.exit(main())
PY
