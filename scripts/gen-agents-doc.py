"""docs/agents.md from crates/nunchiro-core/src/acp/known.toml, so the list of agents and their costs cannot drift from
what the app offers. `python3 scripts/gen-agents-doc.py` writes it; `--check` exits 1 when the file differs."""
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KNOWN = ROOT / "crates/nunchiro-core/src/acp/known.toml"
DOC = ROOT / "docs/agents.md"
WORDS = {"free_plan": "Free plan works", "free_limited": "Free plan, limited", "free_models": "Free models",
         "own_model": "Your own model", "paid_plan": "Paid plan", "paid_key": "Paid key", "unknown": "Cost not checked"}


def render():
    known = tomllib.loads(KNOWN.read_text())["known"]
    lines = [
        "# Agents Nunchiro lists",
        "",
        "Generated from `crates/nunchiro-core/src/acp/known.toml` by `scripts/gen-agents-doc.py`; do not edit by hand.",
        "Settings > Accounts offers these in its add tiles. Nunchiro types an install command into a terminal tab and",
        "never runs it. Costs were read on each vendor's page on the date shown; prices change, so the link is the reference.",
        "",
        "| Agent | ACP command | Install | Sign in | Cost | Checked |",
        "|---|---|---|---|---|---|",
    ]
    code = lambda s: f"`{s}`".replace("|", "\\|") if s else ""  # a pipe would end the table cell
    for k in known:
        if k.get("service"):
            continue
        launch = code(" ".join([k["command"], *k.get("args", [])])) if k["acp"] else "terminal only"
        install = code(" ".join(k["install"])) if k.get("install") else code(k.get("install_script", ""))
        cost = WORDS[k.get("cost", "unknown")]
        if k.get("cost_line"):
            cost += f": {k['cost_line']}"
        if k.get("pricing_url"):
            cost += f" ([plans]({k['pricing_url']}))"
        lines.append(f"| {k['label']} | {launch} | {install} | {code(' '.join(k.get('sign_in', [])))} | {cost} | {k.get('checked', '')} |")
    services = [k["label"] for k in known if k.get("service")]
    lines += ["", f"API key services that run through OpenCode: {', '.join(services)}.", ""]
    return "\n".join(lines)


if __name__ == "__main__":
    text = render()
    if sys.argv[1:] == ["--check"]:
        if DOC.read_text() != text:
            sys.exit("docs/agents.md differs from known.toml: run python3 scripts/gen-agents-doc.py")
    else:
        DOC.write_text(text)
