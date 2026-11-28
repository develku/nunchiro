// The Assistant's folder grant counts only words the owner typed (folder_grant.rs `named`): what was pasted into a
// session's box is noted here and left out of the composer's `folder_offer` text. Window memory only.
// shortcut: a pasted string is cut wherever it shows in the box, so the same words typed by hand next to it are cut
// too; a draft brought back after a reload counts as typed. Upgrade to ranges kept with the draft if that matters.
const pasted = new Map<string, string[]>();

export function notePaste(id: string, text: string) {
  if (text) pasted.set(id, [...(pasted.get(id) ?? []), text]);
}
/** The box's words without what was pasted into it. */
export const typedOnly = (id: string, box: string) => (pasted.get(id) ?? []).reduce((left, p) => left.split(p).join(' '), box);
export const forgetPastes = (id: string) => pasted.delete(id);
