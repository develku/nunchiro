// The two bundled defaults, written as Ghostty-format files: the design book's blend palette (docs/design/design-book,
// NUNCHIRO_*_GHOSTTY in index.html). The window paints these two from tokens.css and book-tokens.css itself
// (themes/apply.ts); this text is the terminal's palette and what the theme gallery's mini window reads.
import { parseGhostty, type ThemeColors } from './ghostty';

export const NUNCHIRO_LIGHT = `background = #fafaf9
foreground = #23272b
cursor-color = #23272b
cursor-text = #fafaf9
selection-background = #d5dee7
selection-foreground = #23272b
palette = 0=#23272b
palette = 1=#b3443b
palette = 2=#4f7d5d
palette = 3=#8f6212
palette = 4=#3f6e96
palette = 5=#8a3b6f
palette = 6=#2f767c
palette = 7=#c9cdd0
palette = 8=#62696f
palette = 9=#c4554b
palette = 10=#5c8c6b
palette = 11=#a5761c
palette = 12=#5b8db5
palette = 13=#9f4f84
palette = 14=#3b8a90
palette = 15=#f1f2f0
`;

export const NUNCHIRO_DARK = `background = #1b1e21
foreground = #e5e7e8
cursor-color = #e5e7e8
cursor-text = #1b1e21
selection-background = #34404b
selection-foreground = #e5e7e8
palette = 0=#2b2f33
palette = 1=#ee8076
palette = 2=#86b293
palette = 3=#d9a441
palette = 4=#7fb0d6
palette = 5=#d49bc4
palette = 6=#7cc4c4
palette = 7=#c9cdd0
palette = 8=#6e757b
palette = 9=#f49a90
palette = 10=#a0c8ac
palette = 11=#e8bc62
palette = 12=#9dc4e2
palette = 13=#e2b4d5
palette = 14=#9ad6d6
palette = 15=#f1f2f0
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
