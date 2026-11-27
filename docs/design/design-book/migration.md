# Moving the app to the design book

v0.1 draft. Order as decided: palette, then gauges, then native glass. Each slice is one PR with before and after screenshots in Nunchiro light, Nunchiro dark and Catppuccin Latte or Mocha, compared against [index.html](index.html) before landing. Sizes are rough working days for one builder.

Counts today (web/src): `var(--you)` 64 uses, `var(--bad)` 60, `var(--hover)` 40, `var(--ok)` 37, `var(--tree-*)` 37, `light-you` 33, `var(--run)` 28, `light-run` 25, `var(--done)` 20, `var(--control-bg)` 19, glass mentions 105, `backdrop-filter` 9.

## Step 1: palette and state light

**1a. Tokens and derive (1.5 days).** Add `design-book/tokens.css` as `web/src/book-tokens.css`, imported right after `tokens.css` in main.tsx. Extend `themes/derive.ts` with the book's rule (index.html, "Theme derive rule"; `derive()` in its script is the reference): new roles `--tint-3 --glass-chrome --glass-float --accent --light-done --light-warn --you-glow --you-text --ok-text --warn-text --primary --on-primary --knob`, new `--page` and `--raised` mixes, `--muted` also checked on the diff tints, warm = mix(palette 3, palette 1, 35%). Write the old names it sets today (`--you`, `--bad`, `--run`, ...) to the same values block 4 of tokens.css gives them, so catalog themes and the bundled pair agree. Update `NUNCHIRO_LIGHT` and `NUNCHIRO_DARK` in themes/nunchiro.ts to the blend's Ghostty text (the terminal palette in index.html's script, `NUNCHIRO_*_GHOSTTY`). Port the book's `pairs()` into a vitest that runs every bundled and catalog theme through `deriveTokens` and fails under 4.5 (words) or 3 (marks).
*On screen:* the whole window takes the blend's warmer greys, chrome one step darker than the chat, cards lift; orange words become the darker ember in light themes; the terminal palette of the Nunchiro theme changes.
*Risk:* `--run` and `--you` change meaning (words vs marks). Block 4 keeps them text-safe, but any rule that used `--you` as a small dot now gets the word colour (darker, still fine). The vitest is the guard for derive contrast.

**1b. Tree rows, tabs, faces (2 days).** Rows 30 -> 34 (compact 22 -> 24), radius 8, padding 0 10 0 24. Replace the coloured row bars (`DoneBars.tsx`, `--tree-*`) and the travelling working line with the book's dots: breathe for working (one shared phase), glow ring for needs you, rings for done and idle, still dot for failed; the needs-you wash; meta words in `--you-text` / `--bad-text`. Tabs: the open tab becomes the reading surface joined to the sheet (radius 8 8 0 0, 30 high); keep the current sizing (180 to 68). Face frame: needs-you outline and glow.
*On screen:* the tree turns from coloured bars to small lights; the one warm thing is the row that needs you.
*Risk:* fewer rows fit (34 vs 30): 20 rows need 680 px. Compact must stay 24 for the hit size. Twenty breathing dots: check the shared phase on a 30-session tree and CPU with the Activity Monitor (opacity and transform only).

**1c. Controls (2 days).** Buttons (three kinds, 28 / 24, radius 7, key chips), icon buttons, fields, selects, search, segmented, checkbox, radio, switch, slider. `.btn` and `.btn.p` move to the book's classes; `--control-bg` uses go warm (one per view: audit each view, demote the rest to secondary). Focus ring: the neutral `--ring-focus` becomes the 2 px `--accent` ring everywhere.
*On screen:* the ink primary buttons become the warm primary; outlined buttons become soft fills; checked states turn ink.
*Risk:* views that today show two ink primaries (Settings pages, onboarding) need a choice of which one stays warm. Grep `.btn.p` per view.

**1d. Cards, menus, dialogs, toasts, empty and loading (2 days).** Permission card swell, question and Outbox cards with the still ring, error card, menus at 26 rows, dialogs and sheets radius 14, toast as a solid raised pill, status-bar note, empty states, skeletons, error lines. Composer radius 16 -> 14.
*On screen:* the docked cards and floating layers match the book; Outbox and permission share one look.
*Risk:* the current glass rule puts the docked permission card on glass; the book makes it solid. Remove `.composer > .dock .deccard` from light-glass.css.

Step 1 total: about 7.5 working days in four PRs. 1a lands first; 1b, 1c, 1d can run in parallel after it.

## Step 2: gauges and figures (2 days, one PR)

`chrome/UsageBlock.tsx` bars -> the 24 × 14 arc with a redline (last 20%), needle and figure; caps captions (USED, 5H, WK) in the status bar only; the popover rows with arcs. `chat/ContextRing.tsx` restyled to the 20 ring with the 80% tick in the session header. Near-limit turns `--light-warn` / `--warn-text` from 80% and never glows (`--glow-limited` is already aliased to none). A tabular-nums audit: grep every time, percent, count and token figure.
*On screen:* the status bar reads like an instrument; the context ring appears in the header.
*Risk:* arcs at 24 px on a non-Retina external display; check at 1x. Keep the usage group one button (24 hit height).

## Step 3: native glass (2 to 3 days, spike first)

Today the window is opaque (`TitleBarStyle::Overlay`, `hidden_title`, no vibrancy). A web view's `backdrop-filter` only blurs the page under it, never the desktop.
1. **Spike (0.5 day):** a transparent window with `NSVisualEffectView` (window-vibrancy crate, material `Sidebar` or `HUDWindow`) or macOS 26 `NSGlassEffectView` behind the web view; the page paints everything opaque except the sidebar panel and the status bar, which become `--glass-chrome`. Measure scroll and terminal streaming FPS with and without.
2. **Sidebar as a floating panel:** inset 8, radius 12, traffic lights moved into it (`traffic_light_position` 20, 20). Window corners stay the system's.
3. **Popovers, menus, tooltips** already take `.glass`; retune to `--glass-float` and `--glass-blur` (24 / 160%).
4. **Reduced transparency** and **increase contrast** paths from tokens.css.
*On screen:* the desktop shows softly through the sidebar and status bar; nothing you read is over glass.
*Risks:* WebKit draws `backdrop-filter` in WKWebView but headless WebKit in Playwright does not, so shots of glass need Chromium or the real app. Native vibrancy needs `macOSPrivateApi` or a transparent window, which changes how the Browser widget's native child view composites (pane/browser/view/covered.ts already blanks glass over it). Text over glass changes with the wallpaper: keep glass alpha at 0.62 / 0.60 or more and keep every word on the sidebar in `--text` or `--muted`. Fallback if the spike fails: the sidebar stays `--page` solid and the book still holds (quiet solid surfaces plus gauges).

## Risks across all steps

- **Theme derive contrast.** The bundled pair is hand-set; every other theme is derived. A theme with a mid-grey background can have no colour that reads 4.5 on every surface; `readable()` then returns the best it found (the vitest should allow and list these). In Catppuccin Mocha the warm and the near-limit yellow sit close; words carry the difference.
- **Drift between book and app.** tokens.css is checked against the book's own values (both must change together); the vitest guards contrast; screenshots are compared with the book before each landing.
- **Earlier choices this replaces.** The ink primary and neutral focus ring, the travelling working line and the glass permission card are replaced by this book. The coloured row bars retire in 1b.
- **Fonts.** WebKit may not resolve "SF Pro Display" by name; if the session title renders in the Text cut, keep 14.5 / 600 and accept it.
