# Nunchiro web

The window's React app. `pnpm test` runs `tsc --noEmit` and the Playwright suite (`tests/`); the fixtures build and drive
the real core binary from this checkout's `target/`.

## Fresh worktree

`cd web && pnpm install`, then `pnpm typecheck` (or `npx tsc --noEmit`). Use pnpm, not `npm ci`: no lockfile is tracked, so
`npm ci` exits 1 (EUSAGE), leaves no `node_modules`, and a bare `npx tsc` then fetches the unrelated `tsc` package
("This is not the tsc command you are looking for").

## Playwright browsers

Browsers come from `~/Library/Caches/ms-playwright` (`pnpm exec playwright install chromium webkit`). An exported
`PLAYWRIGHT_BROWSERS_PATH` wins (`browsers-path.ts`, read by `playwright.config.ts`).

Do not point it at the external SSD. Finding from the V1B-25 receipt (2026-10-26, headless shell 1248 = Chromium
156.0.8078.4, Playwright 1.64.0): the same binary run from `<disk>/.../.scratch/pw` rendered 0 requestAnimationFrame
frames in 1 s and every click timed out (3 of 3 runs); from `~/Library/Caches/ms-playwright` it rendered 9-46 frames and
clicked fine (6 of 6 runs). Cause not proven: why the SSD path stalls rendering was not investigated.

Check, rerunnable: `node raf-probe.mjs` (from `web/`) (one button, rAF count for 1 s, then a click) must report frames > 0 and
the click ok with the default path.
