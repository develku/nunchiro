#!/bin/sh
# Waiting matrix (ticket 01). Prints the matrix with pass counts; exits 1 if guarded user config changed.
# RUNS (default 5) runs per row, PAR parallel sessions. Rows: C1-C6, K (Claude), X1-X3, XK (Codex).
# Every session loads the user's own MCP servers; keep PAR low on a shared host.
set -eu
cd "$(dirname "$0")/../.."
if [ "${1:-}" = "--core" ]; then
  shift
  exec python3 -B - "$@" <<'PYCORE'
import argparse, hashlib, json, os, re, shlex, shutil, signal, socket, subprocess, sys, time, uuid
from pathlib import Path
sys.path.insert(0, str(Path("scripts/scenario").resolve()))
from lib import clean_env, guard_check, snapshot
from matrix import ALL_ROWS, READY, CODEX_ARGS
ap=argparse.ArgumentParser()
ap.add_argument("--runs",type=int,default=int(os.environ.get("RUNS",5)))
ap.add_argument("--rows",default=os.environ.get("ROWS","C1,C2,C3,C4,C5,C6,K,X1,X2,X3,XK"))
a=ap.parse_args()
root=Path.cwd(); binary=root/"target/debug/nunchiro"
if not binary.is_file():
    raise SystemExit("Build first: cargo build --workspace")
out=root/".scratch/receipts"/("r2-core-matrix-"+time.strftime("%Y%m%d-%H%M%S"))
out.mkdir(parents=True)
if not shutil.which("tmux"):raise SystemExit("Independent VT reference requires the installed tmux executable")
reference_version=subprocess.check_output(["tmux","-V"],text=True).strip()
(out/"reference-version.txt").write_text(reference_version+"\n")
(out/"matrix-sha256.txt").write_text(hashlib.sha256(Path("scripts/scenario/matrix.sh").read_bytes()).hexdigest()+"\n")
binary_sha=hashlib.sha256(binary.read_bytes()).hexdigest()
(out/"binary-sha256.txt").write_text(binary_sha+"\n")
usage=subprocess.run([os.path.expanduser("~/.agents/policies/usage.sh")],capture_output=True,text=True)
(out/"usage.txt").write_text(usage.stdout+usage.stderr)
codex_line=next((s for s in usage.stdout.splitlines() if s.startswith("codex .codex ")),"")
def has_headroom(line):
    credits=re.search(r"\bcredits ([\d,]+)",line)
    windows=re.findall(r"(?:5h|7d) (\d+)%",line)
    return bool(credits and int(credits[1].replace(",",""))>0) or bool(windows and all(int(p)<100 for p in windows))
# The model roster explicitly authorizes existing Codex credits when subscription quota is exhausted.
codex_headroom=usage.returncode==0 and has_headroom(codex_line)
if codex_headroom:
    models=subprocess.run(["codex","debug","models"],capture_output=True,text=True)
    (out/"codex-models.txt").write_text(models.stdout+models.stderr)
    if models.returncode or "gpt-5.6-luna" not in models.stdout:
        raise SystemExit("Cheapest Codex model is unverified; inspect codex-models.txt")
rows=a.rows.split(",")
if a.runs<1 or any(r not in list(ALL_ROWS)+["K","XK"] for r in rows):
    raise SystemExit("Invalid runs/rows")
before=snapshot(); results=[]
class Reference:
    # Installed tmux is an independent VT implementation; the core cannot vouch for its own cells.
    def __init__(self,home):
        self.socket=home/"reference.sock";self.fifo=home/"reference.fifo";self.fd=None;self.pid=None
        self.base=["tmux","-u","-S",str(self.socket),"-f","/dev/null"]
        os.mkfifo(self.fifo,0o600);self.fd=os.open(self.fifo,os.O_RDWR|os.O_NONBLOCK)
        try:
            self.command(["new-session","-d","-s","reference","-x","160","-y","50","-c",str(home),"/bin/sh","-c","stty raw -echo; exec /bin/cat < "+shlex.quote(str(self.fifo))])
            os.chmod(self.socket,0o600)
            self.command(["set-option","-g","status","off"])
            dimensions=self.command(["display-message","-p","-t","reference:0.0","#{pane_width}x#{pane_height}"]).strip()
            if dimensions!="160x50":raise RuntimeError("reference dimensions: "+dimensions)
            self.pid=int(self.command(["display-message","-p","#{pid}"]).strip())
        except Exception:self.close();raise
    def command(self,args):
        return subprocess.run(self.base+args,check=True,capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=2).stdout
    def feed(self,data):
        end=time.monotonic()+1
        while data:
            try:data=data[os.write(self.fd,data):]
            except BlockingIOError:
                if time.monotonic()>end:raise RuntimeError("reference input stalled")
                time.sleep(.002)
    def text(self):return self.command(["capture-pane","-p","-t","reference:0.0","-S","0","-E","49"])
    def close(self):
        subprocess.run(self.base+["kill-server"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=2)
        if self.fd is not None:os.close(self.fd);self.fd=None
def one(rid,n):
    killed=rid in ("K","XK"); agent="codex" if rid.startswith("X") else "claude"
    if agent=="codex" and not codex_headroom:
        return dict(row=rid,run=n,status="not run",reason="no verified Codex quota headroom")
    row=ALL_ROWS[("X1" if agent=="codex" else "C1") if killed else rid]
    tag=uuid.uuid4().hex[:8]; home=root/".scratch"/("m-"+tag);home.mkdir(mode=0o700)
    d=out/(rid+"-"+str(n));d.mkdir()
    cwd=home/"cwd" if not row.get("untrusted") else Path("/private/tmp")/("nunchiro-trust-"+tag)
    cwd.mkdir()
    if row.get("untrusted")=="git":subprocess.run(["git","init","-q",str(cwd)],check=True)
    env=clean_env({"NUNCHIRO_HOME":str(home)})
    for k in ("NUNCHIRO_TOKEN","NUNCHIRO_SESSION"):env.pop(k,None)
    log=open(d/"core.log","wb")
    core=None; reference=None; sid=None; target=cwd/("never-"+tag); held_pid=None
    def boot():
        p=subprocess.Popen([str(binary),"serve"],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=log)
        end=time.monotonic()+5
        while not (home/"core.sock").exists():
            if p.poll() is not None or time.monotonic()>end:raise RuntimeError("core did not start")
            time.sleep(.01)
        return p
    def req(op,**kw):
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(5);sock.connect(str(home/"core.sock"))
            sock.sendall((json.dumps(dict(token=(home/"core.token").read_text(),request=dict(op=op,**kw)))+"\n").encode())
            with sock.makefile("rb") as f: response=json.loads(f.readline(8*1024*1024))
        if "Err" in response:raise RuntimeError(response["Err"])
        return response["Ok"]
    try:
        reference=Reference(home)
        core=boot()
        extra=CODEX_ARGS+row.get("extra_args",[]) if agent=="codex" else ["--permission-mode","default"]
        if rid=="C5":extra += ["--allowedTools","Bash(sleep:*)"]
        session=req("start",session=dict(kind=agent,project=str(cwd),model="gpt-5.6-luna" if agent=="codex" else "haiku",args=extra))["session"]
        sid=session["id"];pid=session["pid"]
        if killed:req("queue_connect")
        cursor=0; raw=b""; sent=not bool(row.get("prompt")); t_show=None; t_queue=None; sources=[]; t_sent=time.monotonic(); deadline=t_sent+row.get("timeout",90)
        while time.monotonic()<deadline:
            data=req("read",id=sid,after=cursor);cursor=data["end"]
            incoming=bytes(data["data"]);raw+=incoming;raw=raw[-200000:]
            reference.feed(incoming)
            screen=reference.text()
            if not sent and re.search(READY[agent],screen,re.I|re.S):
                time.sleep(.5)
                text=row["prompt"].format(f=target.name)
                req("send_text",id=sid,text="\x1b[200~"+text+"\x1b[201~")
                time.sleep(.3);req("send_keys",id=sid,keys=["enter"])
                sent=True;t_sent=time.monotonic();raw=b""
            if sent and t_show is None and re.search(row["show"],screen,re.I|re.S):t_show=time.monotonic()
            current=req("snapshot")["sessions"]
            meta=next(s for s in current if s["id"]==sid)
            kinds=["background"] if rid=="C5" else ["dialog"] if row.get("untrusted") else ["question"] if rid in ("C2","X2") else ["permission"]
            items=[i for i in meta.get("pending",[]) if i["kind"] in kinds]
            if sent and items and t_queue is None:t_queue=time.monotonic();sources=sorted(set(s for i in items for s in i["sources"]))
            if killed and items:
                # Keep this owned process unreaped while the core dies; cleanup cannot hit a reused PID.
                os.kill(pid,signal.SIGSTOP);held_pid=pid
                core.kill();core.wait(timeout=5)
                if (home/"core.sock").exists():(home/"core.sock").unlink()
                core=boot();restored=next(s for s in req("snapshot")["sessions"] if s["id"]==sid)
                time.sleep(.2)
                offered_resume=restored["state"]=="resumable" and bool(restored.get("agent_session_id"))
                answer_rejected=False
                if restored.get("pending"):
                    try:req("answer",item=restored["pending"][0]["id"],answer=dict(type="deny"),confirmed=False)
                    except RuntimeError:answer_rejected=True
                ok=bool(restored.get("pending")) and all(not i["actionable"] and i["reconciled"] for i in restored["pending"]) and offered_resume and answer_rejected and not target.exists()
                (d/"snapshot.json").write_text(json.dumps(restored,indent=2))
                return dict(row=rid,run=n,status="pass" if ok else "fail",recovery_passed=ok,sources=sources,restored=bool(restored.get("pending")),offered_resume=offered_resume,answer_rejected=answer_rejected,auto_approved=target.exists(),scope="core death, non-answerable item restored; explicit resume offered; no replay",criterion="needs 32, spec Acceptance 1, ad14883")
            if t_show is not None and t_queue is not None:break
            if t_show is not None and time.monotonic()-t_show>1:break
            time.sleep(.025)
        (d/"pty.log").write_bytes(raw)
        (d/"snapshot.json").write_text(json.dumps(meta,indent=2))
        ok=t_show is not None and t_queue is not None and t_queue-t_show<=1 and not target.exists()
        # Cancel only. Never choose a trust or persistent-settings option.
        if not row.get("untrusted"):req("send_keys",id=sid,keys=["esc"])
        return dict(row=rid,run=n,status="pass" if ok else "fail",sources=sources,queue_latency=None if t_queue is None or t_show is None else round(t_queue-t_show,4),elicited=t_show is not None,auto_approved=target.exists())
    except Exception as e:return dict(row=rid,run=n,status="fail",error=str(e))
    finally:
        if held_pid is not None:
            try:os.killpg(held_pid,signal.SIGKILL)
            except ProcessLookupError:pass
        if core is not None:
            if core.poll() is None:
                try:req("stop")
                except Exception:core.kill()
            try:core.wait(timeout=10)
            except subprocess.TimeoutExpired:core.kill();core.wait()
        if reference is not None:
            reference.close()
            (d/"reference.json").write_text(json.dumps(dict(version=reference_version,server_pid=reference.pid,socket_removed=not reference.socket.exists())))
        log.close()
        # Keep the queue/journal and core logs as receipts; remove no user-owned path.
def trial(rid,n):
    for attempt in range(3):
        result=one(rid,str(n)+"."+str(attempt))
        result.update(binary_sha256=binary_sha,attempt=attempt+1,reference=reference_version)
        if result["status"]!="fail" or result.get("elicited") is not False or result.get("auto_approved"):return result
    result["status"]="not elicited"
    return result
try:
    for rid in rows:
        pilot=min(5,a.runs)
        for n in range(pilot):
            result=trial(rid,n);results.append(result)
            print(json.dumps(result),flush=True)
            with open(out/"results.jsonl","a") as f:f.write(json.dumps(result)+"\n")
            if result["status"]=="not run":break
        if a.runs>5 and all(r["status"]=="pass" for r in results if r["row"]==rid):
            for n in range(5,a.runs):
                result=trial(rid,n);results.append(result);print(json.dumps(result),flush=True)
                with open(out/"results.jsonl","a") as f:f.write(json.dumps(result)+"\n")
finally:
    problems,foreign=guard_check(before,snapshot(),[str(root),str(out),"nunchiro-trust-"])
    (out/"guard.json").write_text(json.dumps(dict(problems=problems,foreign=foreign),indent=2))
print("| Row | Pass | Runs | Sources |")
print("|---|---|---|---|")
for rid in rows:
    rs=[r for r in results if r["row"]==rid]
    print("| %s | %d | %d | %s |"%(rid,sum(r["status"]=="pass" for r in rs),sum(r["status"] not in ("not run","not elicited") for r in rs),", ".join(sorted({s for r in rs for s in r.get("sources",[])}))))
print("guard problems:",problems or "none")
print("foreign changes:",foreign or "none")
print("receipts:",out)
sys.exit(1 if problems or any(r["status"]!="pass" for r in results) else 0)
PYCORE
fi
exec python3 -B scripts/scenario/matrix.py --runs "${RUNS:-5}" --par "${PAR:-3}" \
  --rows "${ROWS:-C1,C2,C3,C4,C5,C6,K,X1,X2,X3,XK}" "$@"
