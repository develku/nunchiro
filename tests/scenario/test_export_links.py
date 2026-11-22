"""Every relative Markdown link in the public export points at a file the export has (scripts/export-public.sh).
Exports HEAD into a temp dir and walks its *.md files; links in fenced code blocks and inline code are not links."""
import os
import re
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LINK = re.compile(r"!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
FENCE = re.compile(r"^(```|~~~).*?^\1", re.S | re.M)
CODE = re.compile(r"`[^`\n]*`")


def dead_links(tree):
    out = []
    for d, dirs, files in os.walk(tree):
        dirs[:] = [x for x in dirs if x not in (".git", "node_modules", "target")]
        for name in files:
            if not name.endswith(".md"):
                continue
            path = os.path.join(d, name)
            with open(path, encoding="utf-8", errors="replace") as f:
                text = CODE.sub("", FENCE.sub("", f.read()))
            for target in LINK.findall(text):
                if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I) or target.startswith(("#", "/")):
                    continue  # a URL, an anchor in the same file, or an absolute path (an example, not a link)
                rel = target.split("#", 1)[0].split("?", 1)[0]
                if rel and not os.path.exists(os.path.normpath(os.path.join(d, rel))):
                    out.append(f"{os.path.relpath(path, tree)}: {target}")
    return out


class ExportLinks(unittest.TestCase):
    def test_finds_a_planted_dead_link(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "docs"))
            open(os.path.join(d, "docs", "here.md"), "w").close()
            with open(os.path.join(d, "README.md"), "w") as f:
                f.write("[ok](docs/here.md#top) [gone](docs/gone.md) `[code](x.md)` [web](https://example.com)\n"
                        "```\n[fenced](y.md)\n```\n")
            self.assertEqual(dead_links(d), ["README.md: docs/gone.md"])

    def test_export_has_no_dead_relative_link(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "tree")
            run = subprocess.run(["sh", os.path.join(ROOT, "scripts", "export-public.sh"), out],
                                 capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(dead_links(out), [])


if __name__ == "__main__":
    unittest.main()
