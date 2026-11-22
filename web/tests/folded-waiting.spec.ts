// CF2 / needs 128: folded heads keep waiting rows, but answers belong to the Decisions panel.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { fakes, gitRepo, PERMISSION, proxy, QUESTION, show } from './decision-rows-seed';
import { seed } from './tree-seed';

for (const head of ['project', 'group'] as const) {
  const fold = async (app: import('@playwright/test').Page) => {
    await app.getByRole('button', { name: head === 'project' ? 'Collapse repo' : 'Collapse group Web', exact: true }).click();
    await app.mouse.move(1000, 600);
    await app.locator('.cbox textarea').focus();
  };
  const folded = (app: import('@playwright/test').Page) => app.getByRole('button', { name: head === 'project' ? 'Expand repo' : 'Expand group Web', exact: true });
  const groupSeed = (core: Core, p: string) => seed(core, { op: 'group_create', name: 'Web', project: p });

  for (const kind of ['safe', 'risky', 'question', 'multiple'] as const) {
    test(`folded_waiting_has_no_inline_answers (${head}, ${kind})`, async ({ app, core }) => {
      fakes(core);
      const p = gitRepo(core, 'repo');
      // Cover both main-folder (head) and worktree decision rows, including sibling lines in a worktree.
      const agent = core.agent(p, 'asking', 'go', head === 'project');
      if (head === 'group') groupSeed(core, p);
      const px = await proxy(app);
      if (kind === 'risky') px.risky.add('asking');
      px.patch((d) => {
        d.deny_note = true;
        return kind === 'multiple' ? [d, { ...d, id: `${d.id}-second` }] : [d];
      });
      await openWindow(app);
      show(agent.cwd, 'go', kind === 'question' ? QUESTION : PERMISSION(kind === 'risky' ? 'rm -rf build' : 'touch out'));
      const q = app.locator(`.q[data-line="${agent.id}"]`);
      await expect(q).toBeVisible();
      await fold(app);
      await expect(folded(app)).toHaveAttribute('aria-expanded', 'false');
      const block = app.locator('.sess').filter({ has: q });
      await expect(block.locator('[data-act="allow"], [data-act="deny"], [data-act="choose"], [data-act="peek"], .dn, .menu')).toHaveCount(0);
      const focus = head === 'project' ? block.locator('.row.wt2') : q;
      await focus.focus();
      for (const key of ['Digit1', 'Digit3', 'Space']) await app.keyboard.press(key);
      await expect(app.locator('.peek, .dn')).toHaveCount(0);
      expect(px.sent).toEqual([]);
      await q.getByRole('button', { name: 'Open in panel', exact: true }).click();
      const card = app.locator(`.dw .deccard[data-session="${agent.id}"], .composer .deccard.docked[data-session="${agent.id}"]`).first(); // ticket 1030: listed, or above the composer
      await expect(card).toBeVisible();
      if (kind === 'safe') {
        await card.locator('[data-act="allow"]').click();
        await expect.poll(() => px.sent.map((s) => s.answer)).toEqual([{ type: 'allow_once' }]);
      } else if (kind === 'risky') {
        const allow = card.locator('[data-act="allow"]');
        await allow.click();
        expect(px.sent).toEqual([]);
        await allow.focus();
        await app.keyboard.press('Enter');
        await expect.poll(() => px.sent.length).toBe(1);
      } else {
        await expect(card.locator('.dc-item')).toHaveCount(kind === 'multiple' ? 2 : 1);
      }
    });
  }

  test(`folded_waiting_opens_session_panel (${head})`, async ({ app, core }) => {
    fakes(core);
    const p = gitRepo(core, 'repo');
    const a = core.agent(p, 'asking', 'go', true);
    if (head === 'group') groupSeed(core, p);
    await openWindow(app);
    show(a.cwd, 'go', PERMISSION('touch out'));
    const q = app.locator(`.q[data-line="${a.id}"]`);
    await expect(q).toBeVisible();
    await fold(app);
    await q.getByRole('button', { name: 'Open in panel', exact: true }).click();
    await expect(app.locator(`.dw .deccard[data-session="${a.id}"]`)).toBeVisible(); // ticket 1030: a screen-only (risky) item is listed
    // The visible Open reaches the asking session's panel in one click without changing saved folds.
    if (head === 'group') await expect.poll(() => fs.readFileSync(path.join(core.home, 'tree.toml'), 'utf8')).toContain('group:Web'); // the fold is saved a moment after the click
    else await expect(folded(app)).toHaveAttribute('aria-expanded', 'false');
  });

  test(`folded_heads_only_treerows_pills / design_conformance (${head})`, async ({ app, core }) => {
    fakes(core);
    const p = gitRepo(core, 'repo');
    const a = core.agent(p, 'asking', 'go', true);
    groupSeed(core, p);
    await openWindow(app);
    show(a.cwd, 'go', PERMISSION('touch out'));
    const q = app.locator(`.q[data-line="${a.id}"]`);
    await expect(q).toBeVisible();
    await fold(app);
    // A folded group draws no project head, only its shared waiting-row budget (tree record, lane choice tree2 part C; needs
    // 130, 092cf089): its own head carries the pills. Folding the project keeps both heads. The Assistants group's head
    // (ticket 1032) is no project head.
    if (head === 'group') await expect(app.locator('.grp[data-project] .head')).toHaveCount(0);
    for (const h of head === 'group' ? ['.pgrp .ghead'] : ['.grp[data-project] .head', '.pgrp .ghead']) {
      await expect(app.locator(`${h} .cstrip > .sg[data-tone="o"]`)).toHaveAttribute('data-n', '1');
      await expect(app.locator(`${h} .r`)).toHaveAttribute('title', /working/);
    }
    const out = path.join(REPO, '.scratch/cf2-shots');
    fs.mkdirSync(out, { recursive: true });
    for (const scheme of ['light', 'dark'] as const) {
      await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await app.screenshot({ path: path.join(out, `${process.env.CF2_PHASE ?? 'after'}-${head}-${scheme}.png`) });
    }
    await expect(q.getByRole('button', { name: 'Open in panel', exact: true })).toBeVisible();
  });
}
