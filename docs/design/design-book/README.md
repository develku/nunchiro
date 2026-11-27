# Nunchiro design book: builder rules

v0.3 draft. The picture of every part, in four themes, with its values: [index.html](index.html). Tokens: [tokens.css](tokens.css). Move order: [migration.md](migration.md).

Parts in the book: colour roles, type, space and radius, layout grid, motion, icons, mark, buttons, icon buttons and key chips, fields, choices, tabs, tree rows, badges and chips, cards, diff and code, menus and popovers, dialogs, toasts and notes, status bar and gauges, empty and loading states, bot faces, scrollbars and focus.

The look is a blend: quiet surfaces where state is a small light, one warm signal when the owner is needed, exact figures and two small gauges where numbers decide something, glass only on the outer chrome.

## Use

- Read the part's section in index.html before you draw it. Copy its sizes, radii and roles. If a part is not in the book, build it from the nearest one and the seven rules below, then add it to the book.
- Colours only through roles: `--page --panel --raised`, `--text --muted --faint`, `--tint-1/2/3`, `--line`, `--glass-chrome --glass-float`, `--accent`, `--light-run --light-you --light-bad --light-done --light-warn`, `--you-glow`, `--you-text --bad-text --ok-text --warn-text`, `--primary --on-primary`. Never a hex value, never a palette primitive (`--ember-500`) in a part.
- Sizes only from the scales: space 4 · 8 · 12 · 20 · 32; type 10 caps · 11 · 11.5 · 12 · 13 · 14.5 · 15 · 17 · 22; radius 4 · 6 · 7 · 8 · 10 · 12 · 14 · round.
- Controls are 28 high (small 24), radius 7. Menu rows 26, radius 6. Tree rows 34 (compact 24), radius 8. Cards radius 12. Composer, dialogs radius 14. Diff and code radius 10.
- Icons: Octicons 16 (12 inside a text line). An icon the set lacks: 16 grid, stroke 1.5, round caps.

## The seven rules

1. **One warm signal.** Warm (`--primary`, `--light-you`, `--you-glow`, `--you-text`) means "needs you" or the one primary action. Never for links, headings, badges or decoration.
2. **Never by colour alone.** Every state shows its word next to its light: working `4:12`, needs you, idle · 2h, done · 12m, failed · exit 1.
3. **Tint steps, not lines.** Part regions with a surface or tint step. Hairlines (`--line`) only on the diff, the composer and fields.
4. **Figures are tabular.** `font-variant-numeric: tabular-nums` on every time, percent, count and token number.
5. **Glass only on the chrome.** Sidebar and status bar use `--glass-chrome`; menus, tooltips and popovers use `--glass-float` with `--glass-filter` and `--glass-shadow`. Tabs, chat, terminal, cards, dialogs and toasts are solid.
6. **One primary per view.** Primary = warm fill; secondary = `--tint-2`; quiet = text, `--tint-1` on hover. A destructive action is secondary or quiet in `--bad-text`, never the primary, never a red fill.
7. **Quiet motion.** Only the working dot breathes (3.6 s, one shared phase) and only the permission card swells (4.8 s). Everything else fades in 200 ms or does not move. Reduced motion stills all of it; reduced transparency makes glass solid.

## Never

- Text in `--faint`, or a state colour as text without its `-text` twin (`--light-you` is a dot colour, `--you-text` is the word).
- A glow on failed or near-limit. Only needs you glows.
- Blue for selection or checked controls: selection is `--tint-2`, checked is ink (`--text`). Blue is the working dot and the focus ring only.
- Removing a focus ring without a 2 px `--accent` replacement. Hit targets under 24 × 24.
- A web-drawn window corner, a 1 px border around a region, a new font size, a new radius, a shadow other than `--shadow-card` and `--shadow-float`.
- Terminal colours from anywhere but the theme file.
- New UI words in another language than English, title case, "please", exclamation marks, internal words (seat, lane, core, PTY).

## Mark

The mark says who made the window; it never shows a state. Files: `docs/brand/assets/` (`logo-mark.svg` 24 grid in currentColor, `logo-menubar.svg` and `logo-menubar-waiting.svg` 16 grid, `app-icon.svg` 128 grid). Use them as they are; a new or redrawn mark is not a builder's call.

- Sizes: minimum 16. Menu bar 16 (template image), onboarding 24, empty window 48, docs site header 20, About 64 (app icon), release notes 32 (app icon), app icon 16 to 512.
- Colour: `--text`, or `--muted` where it should stay quiet. The app icon keeps its own tile. In the menu bar macOS draws the template in the bar's colour; the waiting file adds the one warm dot.
- Clear space: a quarter of the mark's size on every side.
- Where: menu bar, Dock and Finder, About, the onboarding first screen, the empty window, the docs site, the download page, the release notes. Never in the window chrome (title bar or sidebar header): the Dock and the menu bar already name the app, and the sidebar header belongs to the project.
- Never: another colour (no accent, warm or state colour), stretched, glow, shadow or outline, warm (warm means something needs you), on glass or images busier than the chrome.

## Checks before you land

- Screenshot the part in Nunchiro light and dark and one catalog theme (Catppuccin Latte or Mocha). Compare with its index.html section; any gap goes back before landing.
- Every new text/background pair reads 4.5:1 (marks 3:1) in all four themes. The book's contrast section shows how; add the pair to `pairs()` in index.html if it is new.
- App changes run `scripts/check-app.sh`.

## Adding a new part

1. Draw it in index.html: a `<template>` with the part, a values table, and a do/don't pair if it can go wrong in an obvious way. It renders in all four themes by itself.
2. Use existing roles. A new role needs a derive rule (what it starts from, what it must read at, on which surfaces) in the derive table and in `derive()`, and a value in both Nunchiro blocks of tokens.css.
3. Rerun the page's contrast check (the summary line at the bottom must say all pairs pass) and screenshot the part in the four themes.
4. Bump the version line at the top of index.html and this file.

---

## Old token -> new (web/src/tokens.css)

Names not listed keep their value and meaning. "Alias" means tokens.css block 4 re-points the old name, so old rules keep working; move the rule to the new name when you touch it.

| Old | New | Change |
|---|---|---|
| `--page` | `--page` | value: blend chrome ground (`#f1f2f0` / `#15171a`) |
| `--panel` | `--panel` | value: blend reading surface (`#fafaf9` / `#1b1e21`) |
| `--raised` | `--raised` | value: cards lift (`#ffffff` / `#22262a`) |
| `--text --muted --faint --line` | same | values retuned; `--faint` is no longer text |
| `--hover` | `--tint-1` | alias |
| `--tint-1 --tint-2` | same | values retuned; new `--tint-3` |
| `--glass-bg` | `--glass-float` | alias; new `--glass-chrome` for sidebar and status bar |
| `--glass-fill` | `--glass-float-fill` | alias (reduced transparency built in) |
| `--glass-blur` | `--glass-blur` | 28px/190% -> 24px/160% |
| `--ring-focus` | `--accent` | alias; the neutral grey focus ring becomes the accent ring |
| `--accent` | `--accent` | was `var(--run)`; now its own 3:1 value |
| `--run` | `--light-run` (dot), `--text`/`--muted` (words) | alias kept as a 4.5:1 blue for old word uses |
| `--light-run` | `--light-run` | same meaning; now a breathing dot, not a travelling line |
| `--you` | `--you-text` (words), `--light-you` (dot), `--you-glow` (glow) | alias -> `--you-text` |
| `--light-you` | `--light-you` | same meaning (3:1 mark) |
| `--you-bg` | `--you-glow` mixes | alias: `--you-glow` 12% on panel |
| `--glow-you` | `--you-ring`, `--card-you` | alias kept |
| `--bad` | `--light-bad` | alias |
| `--bad-text` | `--bad-text` | value retuned |
| `--glow-bad`, `--glow-limited` | none | alias to `none`: failed and near-limit do not glow |
| `--ok`, `--done` | `--light-done` | alias; done is the moss ring, no longer purple |
| `--ok-text` | `--ok-text` | value retuned |
| `--warn`, `--light-limited` | `--light-warn` | alias; new `--warn-text` for the figure |
| `--idle`, `--tree-idle` | `--faint` | alias |
| `--tree-you --tree-bad --tree-run --tree-mut` | `--light-you --light-bad --light-run --muted` | alias (the coloured row bars become dots) |
| `--control-bg --control-text` | `--primary --on-primary` | alias; the ink primary becomes the warm primary |
| `--control-quiet-bg --control-quiet-hover` | `--tint-2 --tint-3` | alias (secondary button) |
| `--select-bg --select-text --link-text --error` | `--tint-2 --text --text --bad-text` | alias |
| `--on-status` | `--panel` | alias |
| `--chat-code --syn-keyword --syn-string --diff-add --diff-del` | same | Nunchiro values retuned to the blend |
| `--fs-chat` | `--fs-chat` | 14.5 -> 15 |
| `--fs-code` | `--fs-code` | 11.5 -> 12 |
| `--fs-1 --fs-2 --fs-3` | `--fs-meta --fs-ui --fs-chat` | rename when touched (11 -> 11.5 for meta) |
| `--r-16` | `--r-14` | composer 16 -> 14 (slice 1) |
| `--row-radius` | `--r-8` | alias; rows 6 -> 8 |
| `--row` (30) | `--row-h` (34) | compact 22 -> `--row-h-compact` 24 |
| `--motion-breathe` | `--dur-breathe` | alias |
| `--motion-base --motion-fast` | `--dur-fade` | base is aliased (150 -> 200); fast stays 120 for the title-bar slide until it is removed |
| `--motion-travel`, `--run-light-track` | none | the travelling working line retires |
| `--shadow-sm --shadow-md --shadow-pop` | `--shadow-float` | one float shadow |
| `--scrim` | `--scrim` | per scheme now (.3 light, .45 dark) |
| `--font-code` | `--font-mono` | alias |
| new | `--glass-chrome --tint-3 --you-glow --you-text --warn-text --light-done --light-warn --primary --on-primary --knob --face-filter` and all component tokens (`--btn-h`, `--menu-row`, `--tab-max`, ...) | |
