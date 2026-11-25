#!/usr/bin/env python3
"""Counts of the weekly full run (ticket 1152, .github/workflows/full.yml).

usage: full-counts.py <dir of Playwright JSON reports> <shards expected> <rust log file> <sha> <date> <run id>
                      <web job result> <rust-extended job result> <out json>
Writes the counts JSON (fields in docs/measure/README.md) and prints a Markdown table for $GITHUB_STEP_SUMMARY.
Each report is named <project>-<shard>.json; its top-level `errors` (global setup or teardown, after the tests) count
against that project. `clean` is true only when both jobs succeeded, every shard reported, and nothing failed, was
flaky, errored or failed in the Rust set: a run whose web job did not succeed never reads as clean.
`full-counts.py --self-test` checks the counting on tiny reports."""
import json
import pathlib
import re
import sys

STATUS = {"expected": "passed", "unexpected": "failed", "flaky": "flaky", "skipped": "skipped"}
FIELDS = [*STATUS.values(), "errors"]


def count_web(reports):
    """reports: (project, parsed report) pairs."""
    web = {p: dict.fromkeys(FIELDS, 0) for p in ("chromium", "webkit")}

    def walk(suite):
        for spec in suite.get("specs", []):
            for t in spec.get("tests", []):
                web.setdefault(t.get("projectName", ""), dict.fromkeys(FIELDS, 0))[STATUS[t["status"]]] += 1
        for child in suite.get("suites", []):
            walk(child)

    for project, rep in reports:
        web.setdefault(project, dict.fromkeys(FIELDS, 0))["errors"] += len(rep.get("errors", []))
        for top in rep.get("suites", []):
            walk(top)
    return web


def rust_groups(line):
    # `... load=1.2 measure=pass floods=pass live=skipped(no claude codex)` (scripts/extended-tests.sh); load is not a group.
    return {k: v for k, v in re.findall(r"(\w+)=((?:[^ (]|\([^)]*\))+)", line) if k != "load"}


def is_clean(result):
    return (all(r == "success" for r in result["jobs"].values())
            and result["web_shards"]["reported"] == result["web_shards"]["expected"]
            and all(c["failed"] == c["flaky"] == c["errors"] == 0 for c in result["web"].values())
            and result["rust_extended"] is not None and "FAIL" not in result["rust_extended"].values())


def self_test():
    t = lambda project, status: {"projectName": project, "status": status}
    rep = {"suites": [{"specs": [{"tests": [t("chromium", "expected"), t("webkit", "flaky")]}],
                       "suites": [{"specs": [{"tests": [t("chromium", "unexpected"), t("chromium", "skipped")]}]}]}]}
    web = count_web([("chromium", rep), ("chromium", rep)])
    assert web["chromium"] == {"passed": 2, "failed": 2, "flaky": 0, "skipped": 2, "errors": 0}, web
    assert web["webkit"] == {"passed": 0, "failed": 0, "flaky": 2, "skipped": 0, "errors": 0}, web
    line = "2026-11-30 05:30 abc1234 load=2.10 measure=pass floods=FAIL live=skipped(no claude codex)"
    assert rust_groups(line) == {"measure": "pass", "floods": "FAIL", "live": "skipped(no claude codex)"}, rust_groups(line)
    # Every test passed but teardown failed: the error counts, and the run is not clean.
    green = {"suites": [{"specs": [{"tests": [t("webkit", "expected")]}]}], "errors": [{"message": "globalTeardown"}]}
    web = count_web([("webkit", green)])
    assert web["webkit"] == {"passed": 1, "failed": 0, "flaky": 0, "skipped": 0, "errors": 1}, web
    ok = {"jobs": {"web": "success", "rust_extended": "success"}, "web_shards": {"expected": 1, "reported": 1},
          "web": count_web([("webkit", {"suites": green["suites"]})]), "rust_extended": {"measure": "pass"}}
    assert is_clean(ok)
    assert not is_clean({**ok, "web": web})
    assert not is_clean({**ok, "jobs": {"web": "cancelled", "rust_extended": "success"}})
    assert not is_clean({**ok, "web_shards": {"expected": 2, "reported": 1}})
    assert not is_clean({**ok, "rust_extended": None})
    print("full-counts self-test ok")


def main(rep_dir, expected, rust_log, sha, date, run_id, web_job, rust_job, out):
    files = sorted(pathlib.Path(rep_dir).glob("*.json"))
    web = count_web((f.stem.rsplit("-", 1)[0], json.loads(f.read_text())) for f in files)
    log = pathlib.Path(rust_log)
    lines = log.read_text().strip().splitlines() if log.is_file() else []
    result = {
        "sha": sha,
        "date": date,
        "run_id": int(run_id),
        "jobs": {"web": web_job, "rust_extended": rust_job},
        "web": web,
        "web_shards": {"expected": int(expected), "reported": len(files)},
        "rust_extended": rust_groups(lines[-1]) if lines else None,
    }
    result["clean"] = is_clean(result)
    pathlib.Path(out).write_text(json.dumps(result, indent=2) + "\n")
    print(f"## Full run {sha[:12]} ({date}): {'clean' if result['clean'] else 'NOT clean'}\n")
    print(f"Jobs: web {web_job}, rust-extended {rust_job}.\n")
    print("| project | passed | failed | flaky | skipped | errors |\n|---|---|---|---|---|---|")
    for project, c in web.items():
        print(f"| {project} | {' | '.join(str(c[k]) for k in FIELDS)} |")
    print(f"\nWeb shards reported: {len(files)} of {expected}.\n")
    rust = result["rust_extended"]
    print("Rust extended: " + (", ".join(f"{k}={v}" for k, v in rust.items()) if rust else "no result (job did not finish)"))


if __name__ == "__main__":
    self_test() if sys.argv[1:] == ["--self-test"] else main(*sys.argv[1:10])
