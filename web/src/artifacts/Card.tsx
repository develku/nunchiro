// Artifact cards in chat (ticket v1b-06, spec B2): HTML and SVG as an inline preview in 04's sandbox frame (320 px,
// title, Open, network chip), Markdown and images as one line with the title. Every card's height is fixed before
// anything loads, so a card arriving or loading above the view never moves what the user reads (needs 26).
import { useContext, useState, type ReactNode } from 'react'; // V2-10b
import { Pending } from '../chat/pending';
import { openFileAt } from '../files/open';
import { docT } from '../errors';
import type { Key } from '../i18n';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import { ArtifactFrame } from '../sandbox/ArtifactFrame';
import { sessionName } from '../Sidebar';
import { host, type ArtifactData, type Problem, type Target } from './host';
import { select } from './store';
import { loadContent, loadFrame, useWatched, type Watched } from './watch';
import './artifacts.css';

export const CARD_FRAME = 320;

// Ticket 528: the words come from the catalogue in the language <html lang> names, read when shown, so the callers
// (Preview, chat Rows, the Artifacts widget) keep indexing these records as before.
const PROBLEMS: Problem[] = ['missing', 'too_large', 'outside', 'unsupported', 'unavailable'];
const liveWords = (key: (p: Problem) => Key): Record<Problem, string> =>
  Object.defineProperties({} as Record<Problem, string>, Object.fromEntries(PROBLEMS.map((p) => [p, { enumerable: true, get: () => docT()(key(p)) }])));
export const PROBLEM = liveWords((p) => `leftovers.card.${p}` as const);
export const PROBLEM_TEXT = liveWords((p) => `leftovers.card.text.${p}` as const);

/** The card's file: a session path opens in the chat's own session (still right after a resume). */
export const targetOf = (session: string, a: ArtifactData): Target => ({ root: a.root === 'data' ? 'data' : session, path: a.path, type: a.type, title: a.title });

/** Opens the file in 09's read-only file tab. */
export const openInFiles = (t: Target) => openFileAt(t.root, t.path);

export function ProblemChip({ t, why }: { t: Target; why: Problem }) {
  const words = useHtmlLangT(); // ticket 508
  return (
    <>
      <span className="astate" data-problem={why}>
        {PROBLEM[why]}
      </span>
      {why === 'too_large' && (
        <button type="button" className="af-chip" onClick={() => openInFiles(t)}>
          {words('rest.widgets.card.openInFiles')}
        </button>
      )}
    </>
  );
}

/** "changed · show": the file changed after this view; shows the new version only when clicked. */
export function Changed({ w }: { w: Watched<unknown> }) {
  const words = useHtmlLangT(); // ticket 508
  if (w.status !== 'ready' || !w.changed) return null;
  return (
    <button type="button" className="af-chip changed" title={words('rest.widgets.card.changedTitle')} onClick={w.show}>
      {words('rest.widgets.card.changed')}
    </button>
  );
}

/** The bar a card or Preview shows while loading or for a problem: title, then the state chip. */
export function StateBar({ t, w, className }: { t: Target; w: Exclude<Watched<unknown>, { status: 'ready' }>; className: string }) {
  const words = useHtmlLangT(); // ticket 508
  return (
    <div className={className}>
      <span className="af-title" dir="auto">
        {t.title}
      </span>
      {w.status === 'loading' ? <span className="astate">{words('rest.widgets.card.loading')}</span> : <ProblemChip t={t} why={w.status} />}
    </div>
  );
}

/** `refused` (V2-10b): what to show instead of the problem card, so a chat image keeps V2-10a's muted chip; only
 * before the frame was ever shown, as a shown box that shrank would move the text below it. */
export function FrameCard({ session, t, refused }: { session: string; t: Target; refused?: (why: Problem) => ReactNode }) {
  const w = useWatched(t, loadFrame);
  const words = useHtmlLangT(); // ticket 492 (`t` here is the artifact's target)
  const h = host();
  // V2-10c: the library card's "Asked by" is this chat's session as the tree names it, never the page's title.
  const chat = useContext(Pending).session;
  const [shown, setShown] = useState(false);
  if (w.status === 'ready' && !shown) setShown(true);
  if (refused && !shown && w.status !== 'ready' && w.status !== 'loading') return refused(w.status);
  if (w.status === 'ready')
    return (
      <div className="acard frame" data-state="ready" data-path={t.path} data-hash={w.shown.hash}>
        <ArtifactFrame
          artifact={w.shown}
          title={t.title}
          maxHeight={CARD_FRAME}
          srcFor={h.src}
          grant={h.grant}
          requester={chat?.id === session ? sessionName(chat) : undefined}
          actions={
            <>
              <Changed w={w} />
              <button type="button" className="af-chip open" onClick={() => select(session, t)}>
                {words('mw.open')}
              </button>
            </>
          }
        />
      </div>
    );
  return (
    <div className="acard frame" data-state={w.status} data-path={t.path}>
      <div className="artifact-frame">
        <StateBar t={t} w={w} className="af-bar" />
        <div className="abody dim">{w.status === 'loading' ? '' : PROBLEM_TEXT[w.status]}</div>
      </div>
    </div>
  );
}

export const ICON: Record<Target['type'], string> = { html: 'html', svg: 'svg', markdown: 'md', image: 'img' };

/** Markdown and images: one line, read and watched like a frame card; Preview shows the content. */
function LineCard({ session, t }: { session: string; t: Target }) {
  const w = useWatched(t, loadContent);
  const words = useHtmlLangT(); // ticket 492
  return (
    <div className="acard line" data-state={w.status} data-path={t.path} title={w.status === 'ready' || w.status === 'loading' ? t.path : PROBLEM_TEXT[w.status]}>
      <span className="ic mono">{ICON[t.type]}</span>
      <span className="at" dir="auto">
        {t.title}
      </span>
      {w.status === 'ready' ? (
        <>
          <Changed w={w} />
          <button type="button" className="af-chip open" onClick={() => select(session, t)}>
            {words('mw.open')}
          </button>
        </>
      ) : (
        w.status !== 'loading' && <ProblemChip t={t} why={w.status} />
      )}
    </div>
  );
}

export function ArtifactCard({ session, data }: { session: string; data: ArtifactData }) {
  const t = targetOf(session, data);
  return t.type === 'html' || t.type === 'svg' ? <FrameCard session={session} t={t} /> : <LineCard session={session} t={t} />;
}
