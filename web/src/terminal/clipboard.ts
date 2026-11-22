// OSC 52 clipboard writes from terminal output (v1a-35). Output, never input: a read (`?`) is never answered, and a
// write is copied only as the Settings mode allows (ask by default).

/** Largest decoded write accepted (1 MiB). */
export const OSC52_MAX = 1 << 20;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The text and decoded byte count of an OSC 52 write (`<selection>;<base64>`), or null for a read, an empty or broken payload, or one over the cap. */
export function osc52Write(data: string): { text: string; bytes: number } | null {
  const at = data.indexOf(';');
  const b64 = data.slice(at + 1);
  if (at < 0 || !b64 || b64.length % 4 || b64.length > (OSC52_MAX / 3) * 4 + 4 || !B64.test(b64)) return null;
  const bin = atob(b64);
  if (bin.length > OSC52_MAX) return null;
  return { text: new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))), bytes: bin.length };
}

/** Whether the copy happened; never throws. Call it inside the click: WebKit drops a write once the gesture is gone. */
export async function copyText(text: string): Promise<boolean> {
  // A page that is not a secure context (a paired browser over plain HTTP) has no navigator.clipboard (ticket 497).
  if (!navigator.clipboard?.writeText) return execCopy(text);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copies text that is still being read (the whole chat, Q7 point 15). The write starts now, inside the click or key
 *  press, and takes the text when it arrives: WebKit refuses a write that starts after an await ("Chat not copied" in the
 *  app). Never throws; a rejected `text` is a failed copy (the caller reports that promise's own error). */
export async function copyLater(text: Promise<string>): Promise<boolean> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return text.then(copyText, () => false);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((s) => new Blob([s], { type: 'text/plain' })) })]);
    return true;
  } catch {
    return false;
  }
}

/** The old copy command on a hidden read-only textarea, as T3 Code does (useCopyToClipboard.ts); focus goes back after. */
function execCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  const back = document.activeElement as HTMLElement | null;
  // Page text selected outside a field is lost when the textarea takes the selection; a field keeps its own.
  const sel = document.getSelection();
  const ranges = sel && !(back instanceof HTMLInputElement || back instanceof HTMLTextAreaElement) ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i)) : [];
  // Outside an open modal dialog everything is inert, so the textarea goes inside it.
  (back?.closest('dialog') ?? document.body).append(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    back?.focus?.({ preventScroll: true });
    if (sel && ranges.length) (sel.removeAllRanges(), ranges.forEach((r) => sel.addRange(r)));
  }
}
