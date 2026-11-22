/** Look v11/v12 C: Esc in a field that holds typed words only leaves the field (a second Esc closes); true when it did.
 *  Unsaved forms (add a note, a teammate, a machine, a hook, a schedule) lost their words to one Esc. */
export function leaveTypedField(): boolean {
  const field = document.activeElement;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) || !field.value.trim()) return false;
  field.blur();
  return true;
}
