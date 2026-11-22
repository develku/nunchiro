"""v1b memory workload (ticket V1B-24): a deterministic Claude-format transcript of 5,000 chat events (text,
thinking, tool calls, edits, Korean text, 3 artifact-producing writes), the 3 artifact files, a board.toml with
the default columns, and a `claude` wrapper that runs the fixture CLI under the tested version string.
No model, no tokens. Usage: workload_v1b.py DIR   (prints the paths as JSON; the same DIR twice gives the same bytes)
The generator is the only writer: everything lands under DIR, which the caller keeps under the checkout's .scratch/."""
import json, os, stat, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURE = ROOT / "crates/nunchiro/tests/fixtures/agent-cli/claude"
VERSION = "2.1.310 (Claude Code)"  # chat.TESTED_VERSIONS: any other string makes the chat suppress parsed content
EVENTS = 5000
READY = "FIXTURE_READY"
BOARD_TOML = """version = 1

[[columns]]
id = "working"
title = "작업 중"
states = ["working"]

[[columns]]
id = "needs-decision"
title = "결정 필요"
states = ["needs_decision"]
needs_decision = true

[[columns]]
id = "review"
title = "검토"
states = ["review"]

[[columns]]
id = "done"
title = "완료"
states = ["done"]
"""
ARTIFACTS = {
    "report.html": "<!doctype html><html><head><title>Memory report</title></head><body><h1>Memory report</h1>"
                   "<p>Footprint by component. 메모리 사용량 보고서.</p></body></html>\n",
    "chart.svg": "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='60'><title>Footprint chart</title>"
                 "<rect width='120' height='60' fill='#ddd'/><rect x='10' y='20' width='30' height='30' fill='#36c'/></svg>\n",
    "notes.md": "# 측정 노트\n\nChat view open on a 5,000-event session.\n",
}
# Unit start positions (events before it) of the 3 artifact writes: spread over the history.
ARTIFACT_AT = (1200, 2600, 4100)
TEXTS = ("Let me look at the footprint script before changing anything.",
         "측정 스크립트를 먼저 확인해 보겠습니다. 부하가 걸린 상태에서도 비교할 수 있어요.",
         "The ratio to herdr is the fair reading; absolute numbers move with the host's load.",
         "결과를 표로 정리했습니다: 코어, 앱, WebKit 헬퍼를 각각 합산했어요.")


class Builder:
    def __init__(self, project):
        self.project, self.lines, self.events, self.n = str(project), [], 0, 0

    def rec(self, kind, content, extra=None, events=1):
        self.n += 1
        r = {"type": kind, "uuid": f"00000000-0000-4000-8000-{self.n:012d}", "isSidechain": False,
             "message": {"role": kind, "content": content}}
        r.update(extra or {})
        self.lines.append(json.dumps(r, ensure_ascii=False, sort_keys=True))
        self.events += events

    def say(self, i):
        self.rec("user", TEXTS[i % 4] if i % 3 else f"질문 {i}: what changed in step {i}?")
        self.rec("assistant", [{"type": "thinking", "thinking": f"Step {i}: compare the rows, then summarise. 단계 {i}."},
                               {"type": "text", "text": TEXTS[(i + 1) % 4]}], events=2)

    def tool(self, i, name, inp, output, patch=None, artifact=False):
        tid = f"toolu_{i:06d}"
        self.rec("assistant", [{"type": "tool_use", "id": tid, "name": name, "input": inp}])
        extra = {"toolUseResult": {"filePath": inp["file_path"], "structuredPatch": patch}} if patch else None
        self.rec("user", [{"type": "tool_result", "tool_use_id": tid, "content": output}], extra,
                 events=1 + bool(patch) + artifact)

    def unit(self, i, artifact=None):
        if artifact:
            path = f"{self.project}/{artifact}"
            self.tool(i, "Write", {"file_path": path, "content": ARTIFACTS[artifact]}, f"File created successfully at: {path}", artifact=True)
        elif i % 3 == 0:
            self.say(i)
        elif i % 3 == 1:
            self.tool(i, "Bash", {"command": f"echo step {i}"}, f"step {i}\n")
        else:
            path = f"{self.project}/src/step{i % 7}.rs"
            patch = [{"oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 2, "lines": [f"-let a = {i};", f"+let a = {i + 1};", "+let b = 2; // 변경"]}]
            self.tool(i, "Edit", {"file_path": path, "old_string": f"let a = {i};", "new_string": f"let a = {i + 1};"},
                      f"The file {path} has been updated.", patch)


def transcript(project, events=EVENTS):
    """(JSONL bytes, event count by the core's projection rules). Units are 2-3 events; single messages pad the tail."""
    b, i, pending = Builder(project), 0, list(zip(ARTIFACT_AT, ARTIFACTS))
    while b.events < events - 3:
        art = pending.pop(0)[1] if pending and b.events >= pending[0][0] else None
        b.unit(i, art)
        i += 1
    while b.events < events:
        b.rec("assistant", f"Done. 완료 {b.events}.")
    return ("\n".join(b.lines) + "\n").encode(), b.events


def write_if_changed(path, data):
    data = data.encode() if isinstance(data, str) else data
    if not path.exists() or path.read_bytes() != data:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)


def prepare(dest, chat=True):
    """Everything a run needs under `dest` (created); returns the paths. Rerunning rewrites identical bytes."""
    dest = Path(dest).resolve()
    (dest / "bin").mkdir(parents=True, exist_ok=True)
    wrapper = dest / "bin/claude"
    write_if_changed(wrapper, f'#!/bin/sh\n[ "$1" = "--version" ] && {{ echo "{VERSION}"; exit 0; }}\nexec python3 "{FIXTURE}" "$@"\n')
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
    out = dict(bin=str(dest / "bin"), config=str(dest / "claude-config"), project=str(dest / "project"))
    (dest / "project").mkdir(exist_ok=True)
    (dest / "claude-config").mkdir(exist_ok=True)
    if chat:
        for name, text in ARTIFACTS.items():
            write_if_changed(dest / "project" / name, text)
        data, n = transcript(dest / "project")
        write_if_changed(dest / "transcript.jsonl", data)
        write_if_changed(dest / "board.toml", BOARD_TOML)
        out.update(transcript=str(dest / "transcript.jsonl"), events=n, board=str(dest / "board.toml"))
    return out


if __name__ == "__main__":
    print(json.dumps(prepare(sys.argv[1])))
