// V1A-68 (needs 78): "Save to file" for a closed shell's text, to a place the user picks, never under the Nunchiro
// home. In the app the native save panel (the `save_text` command); in a browser a download.
import type { CoreClient } from '../api';
import { inApp } from '../settings/lifetime/tauri';
import { clean } from '../widgets/output';

/** The session's replay as plain text (escapes and controls but newline and tab removed); null when it has none. */
export const plainText = (core: CoreClient, id: string) =>
  core.request({ op: 'read', id, after: 0 }).then(
    (r) => clean(new TextDecoder().decode(new Uint8Array((r as { data: number[] }).data))),
    () => null,
  );

/** `<name>-<YYYY-MM-DD-HHMM>.txt`, local time; path separators in the name become `-`. */
export function fileName(name: string, at: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
  return `${name.replace(/[/\\:]/g, '-')}-${stamp}.txt`;
}

/** The saved file's path in the app ('cancelled' when the user cancels); '' after a browser download. */
export async function download(name: string, text: string): Promise<string> {
  const file = fileName(name, new Date());
  if (inApp()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('save_text', { name: file, text });
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return '';
}
