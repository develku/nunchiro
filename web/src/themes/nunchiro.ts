// The two bundled defaults, written as Ghostty-format files: the ko/ panel and text colours (tokens.css, STYLE
// 2026-10-28) and xterm.js's own ANSI colours, except blue (palette 4), which is the ko/ run hue: derive.ts takes a
// theme's accent from it (designer panel 2026-10-31). The window paints these two from tokens.css itself (themes/apply.ts).
import { parseGhostty, type ThemeColors } from './ghostty';

export const NUNCHIRO_LIGHT = `background = #ffffff
foreground = #1f2328
cursor-color = #1f2328
cursor-text = #ffffff
selection-background = #d8d8d8
palette = 0=#2e3436
palette = 1=#cc0000
palette = 2=#4e9a06
palette = 3=#c4a000
palette = 4=#0969da
palette = 5=#75507b
palette = 6=#06989a
palette = 7=#d3d7cf
palette = 8=#555753
palette = 9=#ef2929
palette = 10=#8ae234
palette = 11=#fce94f
palette = 12=#729fcf
palette = 13=#ad7fa8
palette = 14=#34e2e2
palette = 15=#eeeeec
`;

export const NUNCHIRO_DARK = `background = #151b23
foreground = #e6edf3
cursor-color = #e6edf3
cursor-text = #151b23
selection-background = #676767
palette = 0=#2e3436
palette = 1=#cc0000
palette = 2=#4e9a06
palette = 3=#c4a000
palette = 4=#4493f8
palette = 5=#75507b
palette = 6=#06989a
palette = 7=#d3d7cf
palette = 8=#555753
palette = 9=#ef2929
palette = 10=#8ae234
palette = 11=#fce94f
palette = 12=#729fcf
palette = 13=#ad7fa8
palette = 14=#34e2e2
palette = 15=#eeeeec
`;

/** A chosen theme with its resolved colours, so startup paints without loading the catalog. */
export interface ThemePick {
  /** `nunchiro:light`, `catalog:<name>` or `imported:<name>`. */
  id: string;
  name: string;
  colors: ThemeColors;
  /** Imported themes: where the text came from. */
  source?: string;
  /** V1A-47: themes applied from Browse online carry the upstream licence string (`unknown` and `nonfree` too). */
  licence?: string;
  /** V1A-62: the author's copyright lines a licence asks to travel with the copy (migrated dropped catalog themes). */
  copyright?: string[];
}

export const LIGHT_PICK: ThemePick = { id: 'nunchiro:light', name: 'Nunchiro Light', colors: parseGhostty(NUNCHIRO_LIGHT) };
export const DARK_PICK: ThemePick = { id: 'nunchiro:dark', name: 'Nunchiro Dark', colors: parseGhostty(NUNCHIRO_DARK) };
