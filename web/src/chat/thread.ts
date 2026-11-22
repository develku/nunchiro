// Q7 point 15: the whole chat as plain text for the clipboard: every user and agent message, oldest first, read through
// the core's `chat_page` (the events the chat itself shows as messages), each under its speaker's name.
import type { CoreClient } from '../api';
import { sessionName } from '../sessionNames';
import type { Session } from '../types';
import type { T } from '../i18n';

type Page = { events?: { data?: Record<string, unknown> }[]; before?: number | null };
// shortcut: 100 pages, as the core's hand-off walk (chat/handoff.rs PAGES); a longer chat copies its newest 100 pages.
const PAGES = 100;

export async function threadText(core: CoreClient, s: Session, t: T): Promise<string> {
  const pages: Page[] = [];
  let before: number | undefined;
  for (let i = 0; i < PAGES; i++) {
    const page = ((await core.request({ op: 'chat_page', id: s.id, ...(before !== undefined ? { before } : {}) })) as { page?: Page }).page;
    if (!page) break;
    pages.unshift(page);
    if (typeof page.before !== 'number') break;
    before = page.before;
  }
  const [you, agent] = [t('mw.ss.who.you'), sessionName(s)];
  return pages
    .flatMap((p) => p.events ?? [])
    .map(({ data }) => {
      const text = typeof data?.text === 'string' ? data.text.trim() : '';
      if (!text) return '';
      if (data?.kind === 'message' && data.role === 'user') return `${you}:\n${text}`;
      if ((data?.kind === 'message' && data.role === 'assistant') || data?.kind === 'final_text') return `${agent}:\n${text}`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}
