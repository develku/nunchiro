"""p08's two field figures from the delivery record of the owner's own app (read only).

`nunchiro serve status --json` carries the core's record of the last 30 days (docs/cli.md): per local day, prompts
delivered, resent by the core and that needed a person; per core restart, sessions running before and back after.
Over the last 7 days:

  missed_prompts_per_1000  prompts that needed a person per 1,000 delivered
  seats_lost_per_restart   sessions running before minus back after, averaged over the restarts

Both need 7 days of record (its first day at least 6 days before today); seats_lost_per_restart also needs a restart
and missed_prompts_per_1000 a delivered prompt in those days. `scorecard.py record` writes them into the manual file.
"""
import argparse
import datetime
import json
import subprocess

DAYS = 7


def figures(status, today):
    """{figure: value} and the counts behind them, from a `serve status --json` reply; `today` a datetime.date."""
    rec = status.get("record") or {}
    days = rec.get("days") or {}
    first = today - datetime.timedelta(days=DAYS - 1)
    week = {d: v for d, v in days.items() if datetime.date.fromisoformat(d) >= first}
    since_ms = datetime.datetime.combine(first, datetime.time()).timestamp() * 1000
    restarts = [r for r in rec.get("restarts") or [] if r["at_ms"] >= since_ms]
    delivered = sum(v.get("delivered", 0) for v in week.values())
    person = sum(v.get("person", 0) for v in week.values())
    resent = sum(v.get("resent", 0) for v in week.values())
    out = dict(delivered=delivered, resent=resent, person=person, restarts=len(restarts),
               lost=sum(max(0, r["before"] - r["after"]) for r in restarts),
               first_day=min(days) if days else None, enough=bool(days) and min(days) <= first.isoformat(),
               figures={})
    if out["enough"] and delivered:
        out["figures"]["missed_prompts_per_1000"] = round(person * 1000 / delivered, 2)
    if out["enough"] and restarts:
        out["figures"]["seats_lost_per_restart"] = round(out["lost"] / len(restarts), 2)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog="record", description="p08's field figures; see docs/measure/rubric.md")
    ap.add_argument("--nunchiro", default="nunchiro", help="the owner's app's CLI (default: nunchiro on PATH)")
    ap.add_argument("--report", help="a saved `serve status --json` reply instead of asking the app")
    a = ap.parse_args(argv)
    if a.report:
        with open(a.report) as f:
            status = json.load(f)
    else:
        status = json.loads(subprocess.run([a.nunchiro, "serve", "status", "--json"], capture_output=True, text=True,
                                           check=True).stdout)
    res = figures(status, datetime.date.today())
    print(json.dumps(res, indent=1))
    return res


def self_test():
    today = datetime.date(2026, 12, 10)
    day = lambda n: (today - datetime.timedelta(days=n)).isoformat()  # noqa: E731
    at = lambda n: datetime.datetime.combine(today - datetime.timedelta(days=n), datetime.time(12)).timestamp() * 1000  # noqa: E731
    status = {"core": True, "holders": [], "record": {
        "days": {day(9): {"delivered": 50, "person": 50}, day(6): {"delivered": 600, "resent": 3, "person": 1},
                 day(0): {"delivered": 400, "person": 1}},
        "restarts": [{"at_ms": at(9), "before": 9, "after": 0}, {"at_ms": at(5), "before": 4, "after": 4},
                     {"at_ms": at(1), "before": 5, "after": 3}]}}
    r = figures(status, today)
    assert r["figures"] == {"missed_prompts_per_1000": 2.0, "seats_lost_per_restart": 1.0}, r
    assert (r["delivered"], r["resent"], r["person"], r["restarts"]) == (1000, 3, 2, 2), r
    short = {"record": {"days": {day(3): {"delivered": 10}}, "restarts": [{"at_ms": at(1), "before": 4, "after": 4}]}}
    assert figures(short, today)["figures"] == {}, "fewer than 7 days of record"
    assert figures({"core": False, "holders": []}, today)["figures"] == {}, "an older app with no record"
    quiet = {"record": {"days": {day(6): {"delivered": 5}}, "restarts": []}}
    assert figures(quiet, today)["figures"] == {"missed_prompts_per_1000": 0.0}, "no restart: no seats figure"
    print("record.py self-test ok")


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        main()
