#!/bin/sh
# Fails when the shipped guidance names a command, flag or path that is not real (scorecard p31 SK1, SK5; p26 MD3):
# - every `nunchiro <command>` and its --flags in a code span or code block of plugin/skills/*/SKILL.md and
#   crates/nunchiro/guides/*/*.md must be documented in docs/cli.md (a ### heading, or a code span in an entry's body),
#   and each flag must appear somewhere in docs/cli.md;
# - every repo path (with a slash) in a code span or link of AGENTS.md and the brief and report templates must exist.
# Called by scripts/check-cli-docs.sh. Env: GUIDANCE_ROOT (repo to check, default this checkout), CLI_DOCS.
set -u
root=${GUIDANCE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
exec python3 -I - "$root" "${CLI_DOCS:-$root/docs/cli.md}" <<'EOF'
import glob, os, re, sys

root, docs_path = sys.argv[1], sys.argv[2]
if not os.path.isfile(docs_path):
    sys.exit(f"check-guidance: {docs_path} not found")
docs = open(docs_path, encoding="utf-8").read()


def command_words(text):
    """'agent ask [--to <seat>] <body>' -> ['agent ask']; 'session list|read' -> both. Same rule as check-cli-docs.sh."""
    out = []
    for w in re.sub(r" \| ", "|", text.replace("`", "")).split():
        if re.match(r"[\[<A-Z.\"']", w) or (out and w.startswith("-")):
            break
        out.append(w)
        if len(out) == 1 and w.startswith("-"):
            break
    if not out:
        return []
    return [" ".join(out[:-1] + [alt]) for alt in out[-1].split("|")]


# A command is documented by its ### heading, or in the body of a shared heading
# ("### `nunchiro task list`" also documents `nunchiro task show <id>`).
known = set()
for line in docs.splitlines():
    m = re.match(r"### `nunchiro (.*)$", line)
    if m:
        known.update(command_words(m.group(1)))
for span in re.findall(r"`nunchiro ([^`\n]+)`", docs):
    known.update(command_words(span))


def code_parts(text):
    """Code blocks and inline code spans: the places a skill shows a command to run."""
    parts = re.findall(r"^```[^\n]*\n(.*?)^```", text, re.S | re.M)
    rest = re.sub(r"^```[^\n]*\n.*?^```", "", text, flags=re.S | re.M)
    return parts + re.findall(r"`([^`\n]+)`", rest)


problems = []
guides = sorted(glob.glob(os.path.join(root, "plugin/skills/*/SKILL.md")) +
                glob.glob(os.path.join(root, "crates/nunchiro/guides/*/*.md")))
for path in guides:
    rel = os.path.relpath(path, root)
    for part in code_parts(open(path, encoding="utf-8").read()):
        for m in re.finditer(r"(?<![\w/.-])nunchiro((?: [a-z][a-z-]*)+)([^;&|\n]*)", part):
            words = m.group(1).split()
            # The longest known prefix is the command; a bare "nunchiro" with no known prefix is a miss.
            # A bare group ("nunchiro browser") counts when a documented command starts with it; "task show" does
            # not pass on "task" alone.
            cmd = next((" ".join(words[:n]) for n in range(len(words), 0, -1) if " ".join(words[:n]) in known
                        or (n == len(words) and any(k.startswith(" ".join(words) + " ") for k in known))), None)
            if cmd is None:
                problems.append(f"{rel}: nunchiro {' '.join(words[:2])} is not documented in docs/cli.md")
                continue
            for flag in re.findall(r"(?<![\w-])(--[a-z][a-z0-9-]*)", m.group(0)):
                if not re.search(re.escape(flag) + r"(?![a-z0-9-])", docs):
                    problems.append(f"{rel}: nunchiro {cmd} {flag} is not in docs/cli.md")

surface = ["AGENTS.md", "crates/nunchiro/guides/orchestration/brief-template.md",
           "crates/nunchiro/guides/orchestration/report-template.md"]
for rel in surface:
    path = os.path.join(root, rel)
    if not os.path.isfile(path):
        if rel == "AGENTS.md":  # the public export (scripts/public-exclude.txt) has no AGENTS.md; the others ship
            continue
        problems.append(f"{rel}: missing")
        continue
    text = open(path, encoding="utf-8").read()
    for target in re.findall(r"`([^`\s]+)`", text) + re.findall(r"\]\(([^)\s#]+)", text):
        # A repo path has a slash; bare names like REPORT.md are files a worker writes. No placeholder, no URL.
        # .scratch/ is ignored run state that a seat writes when needed (the Lead handoff file), absent in a fresh worktree.
        if "<" in target or "://" in target or target.startswith("-") or "/" not in target or target.startswith(".scratch/"):
            continue
        if not glob.glob(os.path.join(root, target.rstrip("/"))):
            problems.append(f"{rel}: path {target} does not exist")

for p in problems:
    print(p, file=sys.stderr)
if problems:
    sys.exit(1)
print(f"guidance names {len(known)} documented commands; {len(guides)} guides and {len(surface)} instruction files checked")
EOF
