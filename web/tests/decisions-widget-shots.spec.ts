// decisionw design conformance: the approved mockup's Decisions sidebar next to the app's, light and dark, for
// `.scratch/decisionw/side-by-side.html` (REPORT). Not part of the gate: run with DW_SHOTS=1.
// The mockup is copied once to `.scratch/decisionw/mock/` with the `</script>` its last script lacks.
import fs from 'node:fs';
import path from 'node:path';
import { REPO, expect, openWindow, test } from './fixtures';
import { fakes, gitRepo, PERMISSION, proxy, show } from './decision-rows-seed';
import { icon } from './d5b';

test.skip(!process.env.DW_SHOTS, 'screenshots for the side-by-side page: DW_SHOTS=1');
const OUT = path.join(REPO, '.scratch/decisionw');
const SHOTS = path.join(OUT, 'shots');

test('shots', async ({ app, core, browser }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  fakes(core);
  const p = gitRepo(core, 'repo');
  const a = core.agent(p, 'ux-fix-2', 'go-a', true) as { id: string; cwd: string };
  const b = core.agent(p, 'layout-d5', 'go-b', true) as { id: string; cwd: string };
  const px = await proxy(app);
  px.risky.add('layout-d5');
  await openWindow(app);
  show(a.cwd, 'go-a', PERMISSION('cargo test --workspace'));
  show(b.cwd, 'go-b', PERMISSION('rm -rf build'));
  await expect(app.locator(`.q[data-line="${b.id}"]`)).toBeVisible({ timeout: 8000 });
  await expect(app.locator(`.q[data-line="${a.id}"]`)).toBeVisible({ timeout: 8000 });
  await icon(app, 'right', 'Decisions').click();
  await expect(app.locator('aside.sbar[data-side="right"] .deccard')).toHaveCount(2);
  const mock = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await app.waitForTimeout(300);
    await app.screenshot({ path: path.join(SHOTS, `decisions-app-${scheme}.png`) });
    await mock.emulateMedia({ colorScheme: scheme });
    await mock.goto(`file://${OUT}/mock/frame-ko-d.html`);
    await mock.evaluate((s) => (document.documentElement.dataset.theme = s), scheme);
    await mock.addStyleTag({ content: 'h1,h1+p,.note,.tg,.notes{display:none!important}body{padding:0!important}.mw,.app,#app{height:100vh!important;border-radius:0!important;border:0!important}' });
    await mock.locator('.ri[data-r="dec"]').click();
    await mock.screenshot({ path: path.join(SHOTS, `decisions-mock-${scheme}.png`) });
  }
  const cell = (f: string) => `<a href="shots/${f}.png"><img src="shots/${f}.png" loading="lazy"></a>`;
  fs.writeFileSync(
    path.join(OUT, 'side-by-side.html'),
    `<!doctype html><meta charset="utf-8"><title>decisionw: mockup vs app</title><style>body{font:14px system-ui;margin:16px;background:#f6f6f4;color:#1f2328}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d1d9e0;padding:6px;vertical-align:top;width:50%}img{width:100%;display:block}h2{margin:18px 0 4px}small{color:#59636e}</style>
<h1>decisionw: Decisions sidebar, mockup (frame-ko-d, right-bar 결정) next to the app (1440x900)</h1>
${(['light', 'dark'] as const).map((s) => `<h2>${s}</h2><small>App: two seeded items, one risky (layout-d5); mockup shows its example items.</small><table><tr><th>Mockup</th><th>App</th></tr><tr><td>${cell(`decisions-mock-${s}`)}</td><td>${cell(`decisions-app-${s}`)}</td></tr></table>`).join('')}`,
  );
});
