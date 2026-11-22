// Ticket 371 item 22: any file reaches a prompt as an @path, as text only. Nothing here sends, reads the file or writes a key.
// In the app the OS drop arrives through Tauri's own event, the one route that knows the real path of every file type.

export const inApp = () => '__TAURI_INTERNALS__' in window;

// Line breaks, controls and invisible format characters (zero-width, tag, direction overrides): in a prompt they would forge lines or hide what is sent.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** The text for one path, quoted when it holds a space, or null when no text could say it faithfully. */
export function atPath(path: string): string | null {
  if (path.search(UNSAFE) !== -1) return null;
  if (!/\s/.test(path)) return `@${path}`;
  return path.includes('"') ? null : `@"${path}"`;
}

/** Says something about one composer box under its chips (useImages shows it); '' clears it. */
let say: (session: string, message: string) => void = () => {};
export const note = (box: HTMLElement, message: string) => box.dataset.chipSession && say(box.dataset.chipSession, message);

/** The insertQuote pattern: set the value, let the composer's own input handling run, focus. Never sends. */
export function insertPaths(box: HTMLElement, paths: string[]) {
  const el = box.querySelector<HTMLTextAreaElement>('textarea:not(.hoff-edit)');
  if (!el || el.disabled) return;
  const left = paths.filter((p) => !atPath(p)).map((p) => (p.split('/').pop() ?? p).replace(UNSAFE, '?'));
  note(box, left.length ? `Left out, the name can't be written as a path: ${left.join(', ')}` : '');
  const text = paths.flatMap((p) => atPath(p) ?? []).join(' ');
  if (!text) return;
  el.value += `${el.value && !/\s$/.test(el.value) ? ' ' : ''}${text} `;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
}

let mounted = false;
/** Listens once per window; a drop outside a composer does nothing. The browser build has no such event. */
export async function mountNativeDrop(report: typeof say) {
  if (mounted || !inApp()) return;
  mounted = true;
  say = report;
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type !== 'drop') return;
      const scale = window.devicePixelRatio || 1;
      const box = document.elementFromPoint(payload.position.x / scale, payload.position.y / scale)?.closest<HTMLElement>('.cbox');
      if (box) insertPaths(box, payload.paths);
    });
  } catch (e) {
    console.warn('file drop is unavailable', e);
  }
}
