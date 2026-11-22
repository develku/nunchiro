// The one way a theme from outside enters the app (needs 55): Ghostty-format text plus where it came from. The Theme
// page's paste and file import use it; a later online theme browser hands its download here the same way.
import { FILE_CAP, parseGhostty } from './ghostty';
import type { Key } from '../i18n';
import type { ThemePick } from './nunchiro';

type T = (key: Key, args?: Record<string, string | number>) => string;

export interface ThemeImport {
  name: string;
  text: string;
  /** Where the text came from (http or https URL), shown as text only. */
  source?: string;
}

const HAS = (key: string, text: string) => new RegExp(`^\\s*${key}\\s*=\\s*#[0-9a-f]{6}\\s*$`, 'im').test(text);
export const isSource = (v: unknown): v is string => typeof v === 'string' && v.length <= 500 && /^https?:\/\/\S+$/i.test(v);

export function importTheme({ name, text, source }: ThemeImport, taken: string[], t: T): { pick: ThemePick } | { error: string } {
  const n = name.trim();
  if (!n || n.length > 80) return { error: t('own.theme.name') };
  if (taken.includes(n)) return { error: t('own.theme.taken', { name: n }) };
  if (text.length > FILE_CAP) return { error: t('settings.theme.tooLarge', { kib: FILE_CAP / 1024 }) };
  if (!HAS('background', text) || !HAS('foreground', text)) return { error: t('own.theme.noColours') };
  if (source !== undefined && source !== '' && !isSource(source)) return { error: t('own.theme.source') };
  return { pick: { id: `imported:${n}`, name: n, colors: parseGhostty(text), ...(source ? { source } : {}) } };
}
