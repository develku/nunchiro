// Ticket 990 slice h (scorecard L12): notes are lessons the user kept, read by agents. The core owns them
// (crates/nunchiro-core/src/notes.rs, `{op:'note'}`); every operation answers with the whole list.
import type { CoreClient } from '../api';
import type { T } from '../i18n';
import { basename } from '../tree';

export type Scope = { kind: 'me' } | { kind: 'role'; role: string } | { kind: 'project'; project: string; area?: string | null };
export type ScopeKind = Scope['kind'];
export interface Note {
  id: string;
  text: string;
  scope: Scope;
  source: string;
  cites?: string;
  at: number;
  edited?: number;
  /** The cited file is gone from the project. */
  missing?: boolean;
}

export const noteOp = async (core: CoreClient, op: Record<string, unknown>) => ((await core.request({ op: 'note', ...op })) as { notes: Note[] }).notes;

/** The folder of a cited file, the area a project note narrows to (null for a file at the project's root). */
export const areaOf = (cites?: string) => (cites?.includes('/') ? cites.slice(0, cites.lastIndexOf('/')) : null);
const titled = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

/** The words of a scope choice: "This project · shop/", "Reviewer everywhere", "About me". */
export function scopeWords(t: T, s: Scope, withProject = false): string {
  if (s.kind === 'me') return t('notes.scope.me');
  if (s.kind === 'role') return t('notes.scope.role', { role: titled(s.role) });
  const here = withProject ? basename(s.project) : t('notes.scope.project');
  return s.area ? t('notes.scope.projectArea', { project: here, area: `${s.area}/` }) : here;
}

/** The source as the list shows it; a note the user wrote has the core's "the user". */
export const sourceWords = (t: T, source: string) => (source === 'the user' ? t('notes.you') : t('notes.merge.from', { name: source }));
