# Visual conformance gate: adding a component

1. **Mockup file and selector**: copy the approved ko/ draft into `mockups/` and add its decision and sha256 to `mockups/README.md`; a missing file fails the run. Pick a CSS selector that crops exactly the component; for a dark-only pane use its dark selector (e.g. `.pane.dk`).
2. **Seed data**: give the app the mockup's text and state (project names, labels, counts) through the core CLI, `tree-seed.ts` and the snapshot patch in `visual-conformance.spec.ts`, so the diff measures style, not data.
3. **App locator**: the element that matches the mockup's selector one to one (a row, not the whole pane).
4. **Call**: `await expectMatchesMockup(app, '<file>.html', '<selector>', <locator>, { name: '<component>' })`; pass `prepare` for a hover or focus state on the mockup page.
5. **Threshold**: `MAX_DIFF_RATIO` 0.02 of pixels at `THRESHOLD` 0.1 (pixelmatch rules, anti-aliasing ignored). Never raise them for one component.
6. **Baselines**: none are stored. Each run crops the mockup in the same browser, viewport (1440x900) and scale (2) as the app; the mockup element takes the app element's width first.
7. **No expected failures**: a component over 2% is fixed in the app (markup or tokens), never marked `test.fail` or skipped.
8. Crops and measured ratios land in `.scratch/fidelity-tokens/visual/` for the side-by-side page. Chromium only; `scripts/web-smoke.sh` runs it in the merge gate.
9. **R8 drafts** (02, 05, 06 and round2 keep the R8 grey names in `:root`): pass `prepare: r8Map(app)` (`r8-map.ts`) so the mockup page takes the app's computed value of each R8 name; no hex is copied by hand. The helper itself lives in `compare.ts` (a spec file cannot import another spec); `fidelity-menus.spec.ts` is the worked example.
