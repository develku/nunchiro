/** The one way a divider drag runs (ticket 1076). It sets data-resizing on the root (CSS then selects no text in any pane) and
 *  clears it when the drag ends: release, cancel, lost capture or a blur of the window. A handle that uses it cannot forget either. */
export function resizing(el: HTMLElement, pointerId: number, move: (e: PointerEvent) => void, done?: () => void): () => void {
  const root = document.documentElement;
  let on = true;
  const stop = () => {
    if (!on) return;
    on = false;
    for (const [k, f] of [['pointermove', move], ['pointerup', stop], ['pointercancel', stop], ['blur', stop]] as const) window.removeEventListener(k, f as EventListener);
    el.removeEventListener('lostpointercapture', stop);
    root.toggleAttribute('data-resizing', false);
    done?.();
  };
  el.setPointerCapture(pointerId);
  root.toggleAttribute('data-resizing', true);
  for (const [k, f] of [['pointermove', move], ['pointerup', stop], ['pointercancel', stop], ['blur', stop]] as const) window.addEventListener(k, f as EventListener);
  el.addEventListener('lostpointercapture', stop);
  return stop;
}
