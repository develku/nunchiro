"""Every https host literal in shipped source is named in PRIVACY.md (scorecard p02 RR5 privacy statement, ticket 1130
P2). A new host then fails the gate until the statement names it.

Shipped source: crates/ (not tests/ folders, files named *_tests.rs, or the body of a Rust #[cfg(test)] mod block),
app/src-tauri/src, web/src and plugin, without spec, test and fixture files, and without Python (dev scripts only).
Comment lines are skipped: a link in a comment is a reference, not a connection.
shortcut: only "https://host" literals are found; a host kept as a bare string (the library hosts in libs/grammar.rs) is
listed in PRIVACY.md by hand. Upgrade when a real leak slips past.
"""
import os
import re
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
SOURCES = ("crates", "app/src-tauri/src", "web/src", "plugin")
EXTS = (".rs", ".ts", ".tsx", ".js", ".mjs", ".json", ".sh", ".html", ".css")
SKIP_DIRS = {"node_modules", "target", "tests", "dist", "__tests__", "fixtures"}
HOST = re.compile(r"https://([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")
# Names reserved by RFC 2606 / 6761: never reachable, so never a connection.
RESERVED = re.compile(r"(^|\.)(example(\.(com|org|net))?|invalid|test|localhost)$")


TEST_MOD = re.compile(r"#\[cfg\(test\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{")


def blank_test_mods(text):
    """Blanks the body of each #[cfg(test)] mod block, keeping its newlines so line numbers stay right; code after the
    block is scanned. shortcut: braces are counted without reading strings or comments, so an unbalanced brace inside a
    test string ends the skip early or late; upgrade to a Rust tokenizer if that ever hides or invents a host."""
    out, pos = [], 0
    for m in TEST_MOD.finditer(text):
        if m.start() < pos:
            continue
        depth, i = 1, m.end()
        while i < len(text) and depth:
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            i += 1
        out.append(text[pos : m.start()])
        out.append(re.sub(r"[^\n]", " ", text[m.start() : i]))
        pos = i
    return "".join(out) + text[pos:]


def shipped_hosts(root=ROOT):
    found = {}
    for top in SOURCES:
        for d, dirs, files in os.walk(os.path.join(root, top)):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
            for name in files:
                if not name.endswith(EXTS) or re.search(r"\.(test|spec)\.", name) or name.endswith("_tests.rs"):
                    continue
                path = os.path.join(d, name)
                with open(path, encoding="utf-8", errors="ignore") as f:
                    text = f.read()
                if name.endswith(".rs"):
                    text = blank_test_mods(text)
                for n, line in enumerate(text.splitlines(), 1):
                    if line.strip().startswith(("//", "/*", "*", "#")):
                        continue
                    for host in HOST.findall(line):
                        host = host.lower()
                        if not RESERVED.search(host):
                            found.setdefault(host, "%s:%d" % (os.path.relpath(path, root), n))
    return found


def named_hosts(root=ROOT):
    with open(os.path.join(root, "PRIVACY.md"), encoding="utf-8") as f:
        rows = [l for l in f.read().splitlines() if l.startswith("|")]
    return {h.lower() for r in rows for h in re.findall(r"`([a-z0-9.-]+\.[a-z]{2,})`", r.split("|")[1])}


class OutboundHosts(unittest.TestCase):
    def test_every_shipped_host_is_in_privacy_statement(self):
        named = named_hosts()
        missing = {h: at for h, at in shipped_hosts().items() if h not in named}
        self.assertEqual(missing, {}, "add these hosts to the table in PRIVACY.md (host: first place it is used)")

    def test_scanner_finds_a_planted_host(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "web/src"))
            os.makedirs(os.path.join(tmp, "crates/x/src"))
            with open(os.path.join(tmp, "web/src/a.ts"), "w") as f:
                f.write("// https://comment.org/ is skipped\nfetch('https://Leak.dev/x');\nfetch('https://a.example.com');\n")
            with open(os.path.join(tmp, "crates/x/src/b.rs"), "w") as f:
                f.write(
                    'const U: &str = "https://real.dev/";\n'
                    '#[cfg(test)]\nmod tests {\n    fn t() { let _ = "https://only-test.dev"; }\n}\n'
                    'pub fn after() -> &\'static str { "https://after-tests.dev" }\n'
                    '#[cfg(test)]\n#[allow(dead_code)]\nmod more { mod inner { const X: &str = "https://nested-test.dev"; } }\n'
                )
            found = shipped_hosts(tmp)
            self.assertEqual(set(found), {"leak.dev", "real.dev", "after-tests.dev"})
            # A shipped function after an inline test module is scanned, at its real line.
            self.assertEqual(found["after-tests.dev"], os.path.join("crates", "x", "src", "b.rs") + ":6")


if __name__ == "__main__":
    unittest.main()
