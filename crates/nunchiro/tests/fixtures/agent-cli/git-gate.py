#!/usr/bin/env python3
"""Gate a synthetic worktree removal so a concurrent start can be tested (run by the `git` shim only while pause-remove exists)."""
import os, pathlib, sys, time
home=pathlib.Path(os.environ['NUNCHIRO_HOME'])
if (home/'pause-remove').exists() and 'worktree' in sys.argv and 'remove' in sys.argv:
    (home/'remove-entered').touch()
    until=time.monotonic()+5
    while not (home/'release-remove').exists():
        if not home.exists() or time.monotonic()>=until: sys.exit(1)
        time.sleep(.01)
os.execv('/usr/bin/git',['git']+sys.argv[1:])
