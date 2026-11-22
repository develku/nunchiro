// Ticket 462: scripts/demo-tree-states.sh refuses a Nunchiro home that is not the RC's or a scratch folder, before it
// creates anything (round 2 review: a refused path used to be made, empty, first). Runs on a temp folder only, with
// /usr/bin/true as the binary, so nothing reaches a core.
import { test as plain, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Ticket 534: named as path.join(REPO, 'scripts/<name>.sh') at each call, the one sh shape home-guard.spec.ts allows.
const REPO = path.resolve(import.meta.dirname, '../..');

plain('demo_refuses_before_creating: owner-like homes exit 2 and leave no folder behind', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-462-')));
  try {
    // Round 3: an RC-named folder inside an owner-like folder is refused too.
    for (const home of ['.nunchiro', '.nunchiro-x', 'a.nunchiro/sub', 'deep/er/.nunchiro', '.nunchiro-dev.nunchiro.app.rc/../.nunchiro', '.nunchiro/.nunchiro-dev.nunchiro.app.rc', '.nunchiro-z/.nunchiro-dev.nunchiro.app.rc']) {
      const at = `${tmp}/${home}`; // not path.join: it would fold the `..` case away
      const r = spawnSync('/bin/sh', [path.join(REPO, 'scripts/demo-tree-states.sh'), at, '/usr/bin/true'], { encoding: 'utf8' });
      expect(r.status, `${home}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toContain('refusing');
    }
    expect(fs.readdirSync(tmp), 'nothing created').toEqual([]);
    // A symlink to an owner-like folder is refused through what it points at.
    fs.mkdirSync(path.join(tmp, '.nunchiro-y'));
    fs.symlinkSync(path.join(tmp, '.nunchiro-y'), path.join(tmp, 'link'));
    const r = spawnSync('/bin/sh', [path.join(REPO, 'scripts/demo-tree-states.sh'), path.join(tmp, 'link', 'home'), '/usr/bin/true'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(2);
    expect(fs.readdirSync(path.join(tmp, '.nunchiro-y'))).toEqual([]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
