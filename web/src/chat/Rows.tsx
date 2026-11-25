// One component per chat row kind (R8-final frame 1). Transcript text is untrusted agent output: Markdown renders
// with raw HTML escaped, links leave only through the window's external-link path, and no image URL is loaded
// (V2-10a: a local image is read through the core's confined `file_read` by Thumbnail, never by the webview).
import { createContext, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'; // v1b-12: useLayoutEffect, useRef, useState, MouseEvent
import Markdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkCjkStrong } from './cjk-strong'; // ticket 1065
import remarkMath from 'remark-math'; // ticket 258: math in chat, behind Settings > Appearance > Math in chat
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css'; // bundled with its fonts: no CDN, and nothing new in font-src
import { MATH } from '../features/chat-type';
import { useFeatureSetting } from '../settings/useFeatureSetting';
import { ArtifactCard, FrameCard, PROBLEM_TEXT, targetOf } from '../artifacts/Card'; // v1b-06, V2-10b: FrameCard, PROBLEM_TEXT
import { select } from '../artifacts/store'; // ticket 1086
import { Tr } from '../i18n';
import { plainError, rawError } from '../errors';
import { copyText } from '../terminal/clipboard';
import { openExternal, webUrl } from '../sandbox/link';
import { LinkSpace, openRouted } from '../features/link-routing'; // ticket 256
import { openDiff } from '../diff/Diff'; // v1b-12
import { baseName, openFileAt } from '../files/open'; // needs 171: a path in the chat opens the file
import { docPath, slug } from '../files/docLinks'; // ticket 375
import { pathRef, toolPath } from './paths'; // needs 171
import type { Act } from '../queue/answer'; // v1b-12
import { answer, cardPlan, Pending, sessionPath } from './pending'; // v1b-12
import { groupLine, inputText, outputText, plain, shownOutput, summaryLabel, taskLine, toolLine, type Image, type Row, type Tool } from './model';
import { fileOf, mdSource, nameOf, PathChip, savedPaths, Thumbnail } from '../images/Thumbnail'; // v1b-05, V2-10a: fileOf, mdSource, PathChip; V2-10b: nameOf

export const CAP = 200;
import { Icon } from '../icons/Icon';
import { tilde } from '../settings/shell/Row';
import { ClaudeLinkCards } from './ClaudeLink'; // needs 117
import { ChromeIcon } from '../chrome/icons';
import { handOff, rewind, userView } from './conversation';
import { useSteered } from './queued'; // Q7 point 16
import { useAppControl } from './commandRecord'; // ticket 1019
import { agentState, status } from '../types';
import { TurnFiles } from './TurnFiles'; // ticket 222

/** Ticket 1072: what the lead's "View in Team" line calls (CentreView's openTeam); null where no Team view exists (a peek). */
export const TeamOpen = createContext<(() => void) | null>(null);

/** Expanded rows and "show all" outputs, held above the virtual list so scrolling a row away keeps its state. */
export const Open = createContext<{ has: (k: string) => boolean; toggle: (k: string) => void }>({ has: () => false, toggle: () => {} });

/** Ticket 375: a Markdown file shown from Files: its root (a session id), its folder there, and the root's folder on disk
 *  when known. Relative links, images and `#anchors` resolve against it; chat leaves it null and stays as it was. */
type Doc = { root: string; dir: string; cwd?: string };
export const MdDoc = createContext<Doc | null>(null);

function Link({ href, children, local }: { href?: string; children?: ReactNode; local?: { rel: string; line?: number; open: (el: HTMLElement) => void } }) {
  const t = useContext(Tr);
  const url = local ? null : webUrl(href);
  // Ticket 256: a web link goes where Settings › In-app browser › Links says, in this chat's (or file's) session space.
  const chat = useContext(Pending).session?.id;
  const file = useContext(LinkSpace);
  const go = (el: HTMLElement, shift = false) => (local ? local.open(el) : url && openRouted(url, { session: file ?? chat, shift, origin: file ? 'files' : 'chat' }, openExternal));
  // No href: nothing the webview could follow by itself (middle click, drag, a modifier click).
  return (
    <a
      role="link"
      tabIndex={0}
      className={url || local ? 'mdlink' : 'mdlink off'}
      data-file={local?.rel}
      title={local?.rel ?? url ?? t('chat.row.linkBlocked')}
      onClick={(e) => (e.preventDefault(), go(e.currentTarget, e.shiftKey))}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), go(e.currentTarget, e.shiftKey))}
    >
      {children}
    </a>
  );
}

/** V2-10a: `![alt](src)`. A local path in this session's reach (`mdSource`) renders through Thumbnail; a public web
 * address is a link chip (never loaded); anything else is a muted chip with the path. V2-10b: an SVG never reaches the
 * window as an image; it renders only in v1b's artifact sandbox frame, read by `artifact_open` like an artifact card. */
function MdImage({ src = '', alt }: { src?: string; alt?: string }) {
  const { session } = useContext(Pending);
  const doc = useContext(MdDoc);
  const t = useContext(Tr);
  if (webUrl(src))
    return (
      <span className="mdimg web">
        <Link href={src}>{alt || src}</Link>
      </span>
    );
  // react-markdown empties a `data:`, `file:` or other unsafe address: nothing to read, not the session folder.
  if (!src) return <PathChip path={alt || t('chat.row.imageFallback')} problem={t('chat.row.notLocal')} />;
  if (doc) return <DocImage doc={doc} src={src} alt={alt} />;
  const source = mdSource(src, session);
  const file = fileOf(source);
  if (!file) return <PathChip path={source.path!} problem={t('chat.row.notReadable')} />;
  if (/\.svg$/i.test(file.path))
    return (
      <FrameCard
        session={session!.id}
        t={{ ...file, type: 'svg', title: alt || nameOf(source) }}
        refused={(why) => <PathChip path={source.path!} problem={PROBLEM_TEXT[why]} />}
      />
    );
  return <Thumbnail source={source} inline />;
}

/** Ticket 375: a path a Markdown file names: an absolute one inside the root's folder on disk (agents write these), else
 *  relative to the file (or to the root with `/`). */
const inDoc = (doc: Doc, p: string) => (doc.cwd && p.startsWith('/') && sessionPath(p, doc.cwd)) || docPath(doc.dir, p);

/** Ticket 375: an image a Markdown file names relative to itself, read from the file's root through the core. */
function DocImage({ doc, src, alt }: { doc: Doc; src: string; alt?: string }) {
  const t = useContext(Tr);
  let raw = src;
  try {
    raw = decodeURI(src);
  } catch {
    // Kept as written: the core finds no such file.
  }
  const bare = raw.replace(/[?#].*$/, '');
  const rel = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') ? null : inDoc(doc, bare);
  if (rel === null) return <PathChip path={src} problem={t('chat.row.notReadable')} />;
  const at = { root: doc.root, path: rel };
  if (/\.svg$/i.test(rel)) return <FrameCard session={doc.root} t={{ ...at, type: 'svg', title: alt || baseName(rel) }} refused={(why) => <PathChip path={rel} problem={PROBLEM_TEXT[why]} />} />;
  // The full path keys the thumbnail cache, so two worktrees' same-named images never share an entry.
  return <Thumbnail source={{ type: 'path', path: doc.cwd ? `${doc.cwd.replace(/\/+$/, '')}/${rel}` : `${doc.root}:${rel}`, at }} inline />;
}

/** needs 171: a Markdown link or inline code that names a file of the session opens it in the Files viewer. The path is
 *  made relative by `sessionPath` (it refuses `..`, empty parts and anything outside the folder: such text stays plain);
 *  the Files viewer (core) confines it again. The root of a files.open is the session id. */
const InBlock = createContext(false);

/** `docs/n.md`, `docs/n.md#L12`: a relative href; null for a scheme, `//host`, a `#anchor` or an empty one. */
function localHref(href: string | undefined): { path: string; line?: number } | null {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const line = /#L(\d+)\b/.exec(href)?.[1];
  let path = href.replace(/[#?].*$/, '');
  try {
    path = decodeURI(path);
  } catch {
    return null;
  }
  return path ? { path, ...(line ? { line: Number(line) } : {}) } : null;
}

function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { session } = useContext(Pending);
  const doc = useContext(MdDoc);
  const ref = !webUrl(href) ? localHref(href) : null;
  // Ticket 375: in a Files Markdown tab a relative link opens that file of the same root, `#x` scrolls to its heading.
  if (doc) {
    const rel = ref && inDoc(doc, ref.path);
    let anchor = href?.startsWith('#') ? href.slice(1) : '';
    try {
      anchor = decodeURIComponent(anchor).toLowerCase();
    } catch {
      anchor = '';
    }
    const local = rel
      ? { rel, line: ref?.line, open: () => openFileAt(doc.root, rel, ref?.line) }
      : anchor
        ? { rel: href!, open: (el: HTMLElement) => el.closest('.fv-md')?.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: 'start' }) }
        : undefined;
    return <Link href={href} local={local}>{children}</Link>;
  }
  const rel = ref && session ? sessionPath(ref.path, session.cwd) : null;
  return <Link href={href} local={rel !== null && session ? { rel, line: ref?.line, open: () => openFileAt(session.id, rel, ref?.line) } : undefined}>{children}</Link>;
}

function MdCode({ className, children }: { className?: string; children?: ReactNode }) {
  const { session } = useContext(Pending);
  const inBlock = useContext(InBlock);
  const text = typeof children === 'string' ? children : Array.isArray(children) && children.every((c) => typeof c === 'string') ? children.join('') : null;
  const ref = !inBlock && session && text !== null ? pathRef(text) : null;
  const rel = ref && session ? sessionPath(ref.path, session.cwd) : null;
  const code = <code className={className}>{children}</code>;
  if (!ref || rel === null || !session) return code;
  return (
    <button type="button" className="mdpath" data-file={rel} data-tip={rel} onClick={() => openFileAt(session.id, rel, ref.line)}>
      {code}
    </button>
  );
}

/** CHROME: a fenced block gets a header (its language) and a Copy button (frame-ko-e .code). */
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = (Array.isArray(children) ? children[0] : children) as { props?: { className?: string; children?: ReactNode } } | undefined;
  const text = String(code?.props?.children ?? '').replace(/\n$/, '');
  const lang = /language-(\S+)/.exec(code?.props?.className ?? '')?.[1] ?? 'code';
  const [done, setDone] = useState<boolean | null>(null);
  const t = useContext(Tr);
  return (
    <div className="codeblk">
      <div className="ch2">
        <span>{lang}</span>
        <button
          className="copy"
          onClick={() => void copyText(text).then((ok) => (setDone(ok), setTimeout(() => setDone(null), 1500)))}
        >
          {t(done === null ? 'chat.row.copy' : done ? 'chat.row.copied' : 'about.copyFailed')}
        </button>
      </div>
      <InBlock.Provider value>
        <pre>{children}</pre>
      </InBlock.Provider>
    </div>
  );
}

/** The plain text of rendered Markdown children (a heading's words, for its anchor). */
const textOf = (n: ReactNode): string => (typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : n && typeof n === 'object' && 'props' in n ? textOf((n.props as { children?: ReactNode }).children) : '');

/** Ticket 375: a heading carries its anchor only in a Files Markdown tab (a data attribute: no id clashes between tabs). */
function MdHeading({ level, children }: { level: 1 | 2 | 3 | 4 | 5 | 6; children?: ReactNode }) {
  const doc = useContext(MdDoc);
  const H = `h${level}` as const;
  return <H data-anchor={doc ? slug(textOf(children)) : undefined}>{children}</H>;
}

const components: Components = {
  h1: ({ children }) => <MdHeading level={1}>{children}</MdHeading>,
  h2: ({ children }) => <MdHeading level={2}>{children}</MdHeading>,
  h3: ({ children }) => <MdHeading level={3}>{children}</MdHeading>,
  h4: ({ children }) => <MdHeading level={4}>{children}</MdHeading>,
  h5: ({ children }) => <MdHeading level={5}>{children}</MdHeading>,
  h6: ({ children }) => <MdHeading level={6}>{children}</MdHeading>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => <MdLink href={href}>{children}</MdLink>,
  code: ({ className, children }) => <MdCode className={className}>{children}</MdCode>,
  img: ({ src, alt }) => <MdImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
};

// Agent text: KaTeX keeps `trust: false` (no \href, \url, \htmlId…: they render as text) and react-markdown still
// escapes raw HTML, so math adds no live link and no markup of the agent's own. `maxSize` caps user sizes (\rule, \hspace)
// at 10em; chat.css clips what is still pushed out.
const KATEX: NonNullable<Options['rehypePlugins']>[number] = [rehypeKatex, { trust: false, strict: 'ignore', throwOnError: false, maxSize: 10 }];
const WITH_MATH = { remark: [remarkGfm, remarkCjkStrong, remarkMath], rehype: [KATEX] };
const PLAIN = { remark: [remarkGfm, remarkCjkStrong], rehype: [] };

export function Md({ text }: { text: string }) {
  const plugins = useFeatureSetting(MATH)[0] ? WITH_MATH : PLAIN;
  // Re-parsed only when the text or the plugin set changes, not on every feature write.
  const md = useMemo(
    () => (
      <Markdown remarkPlugins={plugins.remark} rehypePlugins={plugins.rehype} components={components}>
        {plain(text)}
      </Markdown>
    ),
    [text, plugins],
  );
  return (
    <div className="md">
      {md}
      <ClaudeLinkCards text={plain(text)} />
    </div>
  );
}

function ShowAll({ id, total }: { id: string | number; total: number }) {
  const open = useContext(Open);
  const t = useContext(Tr);
  if (total <= CAP) return null;
  return (
    <button className="showall" onClick={() => open.toggle(`${id}:all`)}>
      {open.has(`${id}:all`) ? t('chat.row.showFirst', { n: CAP }) : t('chat.row.showAll', { n: total })}
    </button>
  );
}

/** Long text capped at CAP lines, with "show all". */
function Capped({ id, text, className }: { id: string | number; text: string; className?: string }) {
  const open = useContext(Open);
  const lines = text.replace(/\n$/, '').split('\n');
  const all = open.has(`${id}:all`);
  return (
    <>
      <pre className={className}>{all || lines.length <= CAP ? text : lines.slice(0, CAP).join('\n')}</pre>
      <ShowAll id={id} total={lines.length} />
    </>
  );
}

/** needs 171: `path` splits the row's label ("Read" + "a.ts") so the file name is its own button; the toggle button keeps
 *  the whole label as its name, and a click on the file does not toggle the row. */
interface Part {
  prefix: string;
  text: string;
  rel: string;
  open: () => void;
}
/** needs 172: `tip` is the label's full text on hover (the app tooltip); it shows only while the label is cut, unless it says more than the label (a Read's full path).
 *  Ticket 1039: `tool` marks the label's first word as the tool's name (`.toolname`: Read, Ran, Task); look v35 b S3-2:
 *  it takes the accent (blue, the working light) only while `running`, else the row's muted text. */
function Disclose({ id, label, detail, error, done, running, path, tool, tip = label, children }: { id: number; label: string; detail?: string; error?: boolean; done?: boolean; running?: boolean; path?: Part; tool?: boolean; tip?: string; children: ReactNode }) {
  const open = useContext(Open);
  const t = useContext(Tr);
  const on = open.has(String(id));
  const toggle = () => open.toggle(String(id));
  const cut = tool ? `${label} `.indexOf(' ') : 0; // where the tool's name ends
  const chevron = (
    <span className="c" aria-hidden>
      <Icon name={on ? 'chevron-down' : 'chevron-right'} size={12} />
    </span>
  );
  const tail = (
    <>
      {detail && <span className="pm">{detail}</span>}
      {done && !error && (
        <span className="tdone" role="img" aria-label={t('chat.row.done')}>
          <ChromeIcon name="check" size={12} />
        </span>
      )}
    </>
  );
  return (
    <div className={`tool${error ? ' err' : ''}`} data-running={running || undefined}>
      {path ? (
        <div className="tl tl-path">
          <button type="button" className="tgl" aria-expanded={on} aria-label={label} onClick={toggle}>
            {chevron}
            <span className="tn toolname">{path.prefix}</span>
          </button>
          <button type="button" className="tpath" data-file={path.rel} data-tip={path.rel} onClick={path.open}>
            {path.text}
          </button>
          {tail}
        </div>
      ) : (
        <button className="tl" aria-expanded={on} onClick={toggle} data-tip={tip} data-tip-clip={tip === label ? '' : undefined}>
          {chevron}
          <span className="tn">{cut ? <><span className="toolname">{label.slice(0, cut)}</span>{label.slice(cut)}</> : label}</span>
          {tail}
        </button>
      )}
      {on && <div className="tx">{children}</div>}
    </div>
  );
}

function ToolBody({ tool }: { tool: Tool }) {
  const t = useContext(Tr);
  return (
    <>
      <div className="lbl">{t('chat.row.input')}</div>
      <Capped id={`${tool.key}:in`} text={inputText(tool.use.input)} />
      <div className="lbl">{t('chat.row.output')}</div>
      {tool.result ? (
        <>
          <Capped id={`${tool.key}:out`} text={shownOutput(tool.result.output)} className={tool.result.is_error ? 'err' : ''} />
          <ClaudeLinkCards text={outputText(tool.result.output)} />
        </>
      ) : (
        <p className="dim">{t('chat.row.running')}</p>
      )}
    </>
  );
}

function ToolRow({ tool }: { tool: Tool }) {
  const { session } = useContext(Pending);
  const [label, detail] = toolLine(tool);
  // needs 171: the file the call works on, when it is inside the session folder and the label shows it.
  const p = toolPath(tool.use);
  const rel = p && session ? sessionPath(p, session.cwd) : null;
  // 485 (D9): the label names the file as a Read does; a path inside the folder shows relative (Read keeps its file
  // name), one outside shows its file name with the full path in the tooltip (the window has no home to shorten).
  const named = !!p && label === `${tool.use.name} ${tool.use.name === 'Read' ? baseName(p) : p}`;
  const shown = named ? (tool.use.name !== 'Read' && rel !== null ? rel : baseName(p)) : '';
  const path: Part | undefined = named && rel !== null && session ? { prefix: tool.use.name, text: shown, rel, open: () => openFileAt(session.id, rel) } : undefined;
  return (
    <Disclose tool id={tool.key} label={named ? `${tool.use.name} ${shown}` : label} detail={detail} error={tool.result?.is_error} done={!!tool.result} running={!tool.result} path={path} tip={named && shown !== p ? `${tool.use.name} ${p}` : label}>
      <ToolBody tool={tool} />
    </Disclose>
  );
}

/** Reserved thumbnail slots: the height is fixed before anything loads (ticket 05 fills them). */
function Thumbs({ images, text = '' }: { images: Image[]; text?: string }) {
  // v1b-05: transcript images, then saved paths the composer put on their own lines (an agent that does not attach
  // them still shows what was sent). Each slot keeps the reserved 62×42 box while it loads.
  const sources = [...images.map((im) => im.source), ...savedPaths(text)];
  if (!sources.length) return null;
  return (
    <div className="thumbs">
      {sources.map((source, i) => (
        <Thumbnail key={i} source={source} />
      ))}
    </div>
  );
}

function hunkLines(h: unknown): string[] {
  if (typeof h === 'string') return [h];
  if (!h || typeof h !== 'object') return [];
  const o = h as { oldStart?: number; oldLines?: number; newStart?: number; newLines?: number; lines?: unknown };
  const lines = Array.isArray(o.lines) ? o.lines.filter((l): l is string => typeof l === 'string') : [];
  return [`@@ -${o.oldStart ?? 0},${o.oldLines ?? 0} +${o.newStart ?? 0},${o.newLines ?? 0} @@`, ...lines];
}

// v1b-12: View opens Diff at the file; Accept/Reject only while this call is the session's pending permission
// (pending.ts). The answer slot keeps its width while the call is unresolved, so buttons arriving move nothing; like the
// strip's focus rule, buttons younger than 500 ms, or a press that began before they rendered, do nothing.
function Actions({ row }: { row: Extract<Row, { kind: 'diff' }> }) {
  const { session, boot, matched } = useContext(Pending);
  const t = useContext(Tr);
  const [why, setWhy] = useState('');
  const [error, setError] = useState<{ id: string; raw: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useRef<{ id: string; at: number } | null>(null);
  const down = useRef<number | null>(null);
  const live = !!row.tool && !row.tool.result && !row.more;
  const d = live ? matched.get(row.tool!.use.tool_id) : undefined;
  const p = d && session ? cardPlan(d, session, t) : null;
  const id = d?.id;
  // When these buttons were drawn for this item (after commit, so a discarded render never arms them early).
  useLayoutEffect(() => {
    shown.current = id ? { id, at: performance.now() } : null;
  }, [id]);
  const e = row.edit;
  const view = () => {
    const rel = e.operation === 'delete' || !session ? null : sessionPath(e.destination ?? e.path, session.cwd);
    setWhy(rel !== null ? '' : e.operation === 'delete' ? t('chat.row.fileDeleted') : t('chat.row.outsideFolder'));
    openDiff(rel ?? undefined);
  };
  const send = (a: Act | undefined, ev: MouseEvent) => {
    const at = shown.current && shown.current.id === d?.id ? shown.current.at : Infinity;
    const pressed = down.current;
    down.current = null;
    if (!a || !d || !boot || busy || performance.now() - at < 500 || (ev.detail > 0 && (pressed === null || pressed < at))) return;
    setBusy(true);
    setError(null);
    answer(boot, d.id, a.answer)
      .catch((x: Error) => setError({ id: d.id, raw: rawError(x) }))
      .finally(() => setBusy(false));
  };
  const button = (a: Act | undefined, primary?: boolean) =>
    a && (
      <button
        className={primary ? 'btn p' : 'btn'}
        disabled={busy}
        onPointerDown={() => (down.current = performance.now())}
        // A key that belongs to an IME composition is the IME's, never an answer (keyCode 229 as in App and Palette:
        // under a Korean input source this also blocks keyboard Enter/Space here; the mouse still answers).
        onKeyDown={(k) => (k.nativeEvent.isComposing || k.keyCode === 229) && k.preventDefault()}
        onClick={(ev) => send(a, ev)}
      >
        {a.label}
      </button>
    );
  // An error belongs to the item it was for: a new item, or none, drops it. Ticket 480: plain words; the raw reason is the tooltip.
  const raw = error && error.id === d?.id ? error.raw : '';
  const failed = raw && plainError(t, raw);
  const note = failed || p?.note;
  return (
    <span className="r dacts" data-slot="diff-actions">
      {why && <span className="dim dwhy">{why}</span>}
      <button className="btn" onClick={view}>
        {t('chat.row.view')}
      </button>
      {live && (
        <span className="dask">
          {/* B3/B4: the same words as the strip and the Decisions card for the same answer */}
          {button(p?.accept, true)}
          {button(p?.reject)}
          {note && (
            <span className={failed ? 'note err' : 'note'} title={raw || note} role={failed ? 'alert' : undefined}>
              {note}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/** needs 171: the card's path opens the file (the View button keeps opening the diff). A deleted file has nothing to
 *  open and a path outside the session folder is refused: both stay text. */
function DiffPath({ edit: e }: { edit: Extract<Row, { kind: 'diff' }>['edit'] }) {
  const { session } = useContext(Pending);
  // Ticket 581: inside the session folder the path reads relative, as the changes card's rows do.
  const short = (p: string) => (session && sessionPath(p, session.cwd)) || p;
  const text = e.operation === 'move' && e.destination ? `${short(e.path)} → ${short(e.destination)}` : short(e.path);
  const rel = e.operation === 'delete' || !session ? null : sessionPath(e.destination ?? e.path, session.cwd);
  // B10 (ticket 991): a narrow card cuts the folders, never the file name; the whole path is the tooltip.
  const cut = text.lastIndexOf('/') + 1;
  const parts = (
    <>
      <span className="hd">{text.slice(0, cut)}</span>
      <span className="tl">{text.slice(cut)}</span>
    </>
  );
  if (rel === null || !session)
    return (
      <span className="mono path" title={text}>
        {parts}
      </span>
    );
  return (
    <button type="button" className="mono path" data-file={rel} data-tip={rel} title={text} aria-label={text} onClick={() => openFileAt(session.id, rel)}>
      {parts}
    </button>
  );
}

/** `bare` (look v35 b S3-1): the docked permission card's preview of a pending edit: no View or Accept/Reject, the card answers. */
export function Diff({ row, bare }: { row: Extract<Row, { kind: 'diff' }>; bare?: boolean }) {
  const open = useContext(Open);
  const t = useContext(Tr);
  const { session } = useContext(Pending);
  const e = row.edit;
  const lines = e.hunks.flatMap(hunkLines).map(plain);
  // Ticket 581: an unresolved call while its session waits on a permission reads as asked, not done.
  // shortcut: any permission of the session counts (a screen-text prompt matches no card); match by tool_use_id if Claude ever sends it.
  const waiting = !!row.tool && !row.tool.result && !!session?.pending.some((d) => d.kind === 'permission');
  const all = open.has(`${row.key}:all`);
  const shown = all ? lines : lines.slice(0, CAP);
  const failed = row.tool?.result?.is_error;
  return (
    <div className="dcard" data-path={e.path}>
      <div className="dh">
        <DiffPath edit={e} />
        <span className="dim counts">
          {e.operation === 'delete' ? t('chat.row.deleted') : `+${e.added} −${e.removed ?? 0}`}
          {failed ? ` · ${t('chat.row.failed')}` : ''}
          {waiting && <span className="dwait"> · {t('chat.row.waitingApproval')}</span>}
        </span>
        {!bare && <Actions row={row} />} {/* v1b-12 */}
      </div>
      <div className="dl mono">
        {shown.map((l, i) => (
          <div key={i} className={l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : undefined}>
            {l || ' '}
          </div>
        ))}
      </div>
      <ShowAll id={row.key} total={lines.length} />
    </div>
  );
}

/** "42s", "1m 5s" ("42초", "1분 5초"): a turn's time in the summary line and the working row, in the window's language
 *  (walk 9: a hard-coded "s" stayed English in the Korean window). */
export const elapsed = (s: number) => {
  const lang = document.documentElement.lang || undefined;
  const u = (n: number, unit: string) => new Intl.NumberFormat(lang, { style: 'unit', unit, unitDisplay: 'narrow' }).format(n);
  return s >= 60 ? `${u(Math.floor(s / 60), 'minute')} ${u(s % 60, 'second')}` : u(s, 'second');
};

/** CHROME (CLAUDEFEEL): a turn's tool calls as one line (counts, test result, elapsed) that opens to its steps. */
function Summary({ row, session }: { row: Extract<Row, { kind: 'summary' }>; session: string }) {
  const open = useContext(Open);
  const t = useContext(Tr);
  const id = `sum:${row.key}`;
  const on = open.has(id);
  const time = row.seconds === null ? '' : elapsed(row.seconds);
  return (
    <div className="turnsum">
      <button className="sum" aria-expanded={on} onClick={() => open.toggle(id)}>
        <span className="c" aria-hidden>
          <Icon name={on ? 'chevron-down' : 'chevron-right'} size={12} />
        </span>
        <span className="n">{summaryLabel(row.parts, t)}</span>
        {row.tests && <span>{t('chat.row.tests', { tests: '' })}<span className="ok">{row.tests}</span></span>}
        {time && <span className="t">{time}</span>}
      </button>
      {on && (
        <div className="steps">
          {row.rows.filter((r) => !(r.kind === 'diff' && r.more)).flatMap((r) => r.kind === 'group'
            ? r.tools.map((tool) => <ToolRow key={tool.key} tool={tool} />)
            : [r.kind === 'diff' && r.tool ? <ToolRow key={r.key} tool={r.tool} /> : <RowBody key={r.key} row={r} session={session} />])}
        </div>
      )}
    </div>
  );
}

/** A changed file's path: inside the session folder it is relative; outside it is drawn with the home folder as "~", on one
 *  line: the folder part gives way with an ellipsis, the file name stays whole, the full path is the title (ticket 1057).
 */
function FilePath({ path, cwd }: { path: string; cwd?: string }) {
  const rel = cwd ? sessionPath(path, cwd) : null;
  if (rel) return <span className="p mono">{rel}</span>;
  const shown = tilde(path);
  const cut = shown.lastIndexOf('/') + 1;
  return (
    <span className="p mono out" title={path}>
      <span className="dir">{shown.slice(0, cut)}</span>
      <span className="nm">{shown.slice(cut)}</span>
    </span>
  );
}

/** CHROME: the turn's finished edits as one card; View opens the Diff widget. */
function Changes({ row }: { row: Extract<Row, { kind: 'changes' }> }) {
  const { session } = useContext(Pending);
  const t = useContext(Tr);
  const open = useContext(Open);
  const id = `chg:${row.key}`;
  const all = open.has(id);
  // Ticket 1057: three files, then one button; a turn of four shows all (a "1 more" button would save no room).
  const files = all || row.files.length <= 4 ? row.files : row.files.slice(0, 3);
  const one = row.files.length === 1;
  const nums = (f: { added: number; removed: number }) => (
    <>
      <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
    </>
  );
  const view = (
    <button className="btn" onClick={() => (row.turn ? openDiff(undefined, 'turn', row.turn) : openDiff())}>
      {t('chat.row.viewInDiff')}
    </button>
  );
  return (
    // Ticket 1074: one file says all its head would, so its row carries the button and the card has no head.
    <div className={one ? 'chcard one' : 'chcard'} role={one ? 'group' : undefined} aria-label={one ? t('cards.oneFile', { added: row.added, removed: row.removed }) : undefined}>
      {!one && (
      <div className="h">
        <b>
          {t(row.files.length === 1 ? 'chat.row.changed.one' : 'chat.row.changed.other', { n: row.files.length })}
        </b>
        <span className="dim">
          +{row.added} −{row.removed}
        </span>
        {/* B18 (ticket 991): the count names its scope, as the header pill (whole session) and Diff do. */}
        <span className="dim scope">{t('chat.row.thisTurn')}</span>
        {view}
      </div>
      )}
      <ul className="rows">
        {files.map((f) => (
          <li key={f.path} className={f.artifact && session ? 'art' : undefined}>
            {/* needs 171: the row opens Diff at that file, as the Artifacts widget's file rows do. */}
            <button type="button" className="frow" data-path={f.path} onClick={() => openDiff((session && sessionPath(f.path, session.cwd)) || undefined)}>
              <FilePath path={f.path} cwd={session?.cwd} />
              {!(f.artifact && session) && nums(f)}
            </button>
            {/* Ticket 1086: the file's document card is this Open (Preview), its own tab stop between the path and the numbers. */}
            {f.artifact && session && (
              <>
                <button type="button" className="af-chip open" onClick={() => select(session.id, targetOf(session.id, f.artifact!))}>
                  {t('mw.open')}
                </button>
                <span className="n">{nums(f)}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      {one && view}
      {row.files.length > 4 && (
        <button type="button" className="more" aria-expanded={all} onClick={() => open.toggle(id)}>
          {all ? t('cards.fewer') : t('cards.moreFiles', { n: row.files.length - 3 })}
        </button>
      )}
    </div>
  );
}

/** CF5: a message's labelled actions, available on hover and keyboard focus. needs 171: Copy puts the message's raw text
 *  (the user's text, or the agent's Markdown source) on the clipboard, on a click or Enter only; it also shows for an exited
 *  session's read-only chat. Fork needs a live agent kind. */
function MessageActions({ session, through, text, children }: { session: string; through: string; text: string; children?: ReactNode }) {
  const t = useContext(Tr);
  const { session: source } = useContext(Pending);
  const [copied, setCopied] = useState<boolean | null>(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () =>
    void copyText(text).then((ok) => {
      setCopied(ok);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 1500);
    });
  const fork = source?.kind === 'claude' || source?.kind === 'codex';
  return (
    <div className="message-actions" role="group" aria-label={t('chat.message.actions')}>
      {fork && (
        <button type="button" className="btn" onClick={() => handOff(session, undefined, undefined, through)}>
          {t('chat.message.fork')}
        </button>
      )}
      <button type="button" className="btn" data-copy="" aria-label={t(copied === null ? 'chat.row.copyMessage' : copied ? 'chat.row.copied' : 'about.copyFailed')} onClick={copy}>
        <span aria-live="polite">{t(copied === null ? 'chat.row.copy' : copied ? 'chat.row.copied' : 'about.copyFailed')}</span>
      </button>
      {children}
    </div>
  );
}

/** Ticket 371 item 20: Claude's own picker chooses the point and confirms, so a row only opens it. Not idle (working, or a
 *  question waiting) stays focusable so the reason can be read; a /rewind sent then would wait behind the turn. */
function RewindAction() {
  const t = useContext(Tr);
  const { session: source } = useContext(Pending);
  const why = useId(); // Ticket 412: a disabled control names its reason to screen readers too (aria-describedby to a hidden span), not only in its tooltip.
  if (source?.kind !== 'claude' || agentState(source) !== 'running') return null;
  const idle = status(source) === 'idle';
  return (
    <>
      <button type="button" className="btn" aria-disabled={idle ? undefined : true} data-tip={t(idle ? 'chat.message.rewindTip' : 'chat.message.rewindBusy')} aria-describedby={idle ? undefined : why} onClick={() => idle && rewind(source.id)}>
        {t('chat.message.rewind')}
      </button>
      {!idle && (
        <span id={why} hidden>
          {t('chat.message.rewindBusy')}
        </span>
      )}
    </>
  );
}

// V2-6a: each row is a context-menu target (focusable by click, not by Tab) acting on its chat's session.
// memo: a row's props are the row (stable while its events are), the session id and a key string, so a chat render that changed
// nothing in a row (a session update, the working timer) skips it; context changes (Open, Pending, Tr) still re-render it.
export const RowView = memo(function RowView(p: { row: Row; session: string /* v1b-06 */; messageId?: string }) {
  const message = p.row.kind === 'user' || p.row.kind === 'assistant' || p.row.kind === 'final';
  // Ticket 1019: a command the app typed (the picker's Ultracode toggle) is no bubble, as a worker's wake line (ticket 990).
  const control = useAppControl(p.session, p.row.kind === 'user' ? p.row.key : null);
  return (
    <div data-menu="chat" data-menu-session={p.session} tabIndex={-1} className={message ? `message-row${p.row.kind === 'user' ? (control ? ' message-wake' : ' message-user') : ''}` : undefined}>
      <RowBody row={p.row} session={p.session} control={control} />
      {p.messageId && message && (p.row.kind === 'user' || p.row.kind === 'assistant' || p.row.kind === 'final') && (
        <MessageActions session={p.session} through={p.messageId} text={p.row.text}>
          {p.row.kind === 'user' && <RewindAction />}
        </MessageActions>
      )}
    </div>
  );
});

/** Ticket 1072: a run of worker wake lines (the Team view has what they say) is one quiet centred line. Ticket 1085: a
 *  run of only the core's team lines (heartbeat, nudge) says "Team update". */
function WakeLine({ n, team }: { n: number; team: number }) {
  const t = useContext(Tr);
  const open = useContext(TeamOpen);
  return (
    <div className="msg wake" data-wakes={n}>
      {team === n ? t('cards.teamUpdate') : t(n === 1 ? 'lead.wakes.one' : 'lead.wakes.other', { n })}
      {open && (
        <>
          {' · '}
          <button className="wake-link" onClick={open}>{t('lead.wakes.view')}</button>
        </>
      )}
    </div>
  );
}

/** Q7 point 16: a message that went in as a steer (it stopped the running turn) says so on its bubble. */
function SteerTag({ session, text }: { session: string; text: string }) {
  const t = useContext(Tr);
  return useSteered(session, text) ? <span className="steer-tag">{t('followup.steer')}</span> : null;
}

function RowBody({ row, session, control = false }: { row: Row; session: string; control?: boolean }) {
  const t = useContext(Tr);
  switch (row.kind) {
    case 'user': {
      const v = userView(row.text); // B11: what the user typed, a handoff folded
      // Ticket 1019: a command the app typed (the picker's Ultracode toggle) is a quiet line too.
      if (control) return <div className="msg wake" data-control="">{plain(v.text)}</div>;
      return (
        <div className="msg user">
          <SteerTag session={session} text={row.text} />
          <Thumbs images={row.images} text={row.text} />
          {v.handoff !== undefined && (
            <Disclose id={row.key} label={t('chat.row.handoff')}>
              <Capped id={row.key} text={plain(v.handoff)} className="think" />
            </Disclose>
          )}
          {v.brief !== undefined && (
            <Disclose id={row.key} label={t('chat.row.brief')}>
              <Capped id={row.key} text={plain(v.brief)} className="think" />
            </Disclose>
          )}
          {v.text && <div className="ut">{plain(v.text)}</div>}
        </div>
      );
    }
    case 'assistant':
      // Ticket 1075: an update note is plain assistant text in the muted colour, in every view.
      return row.note ? <div className="unote"><Md text={row.text} /></div> : <Md text={row.text} />;
    case 'final':
      return <Md text={row.text} />;
    case 'image':
      return (
        <div className={row.role === 'user' ? 'msg user' : ''}>
          <Thumbs images={row.images} />
        </div>
      );
    case 'thinking':
      return (
        <Disclose id={row.key} label={t('chat.row.thinking')}>
          <Capped id={row.key} text={plain(row.text)} className="think" />
        </Disclose>
      );
    case 'tool':
      return <ToolRow tool={row.tool} />;
    case 'group': {
      const [label, detail] = groupLine(row.tools);
      return (
        <Disclose tool id={row.key} label={label} detail={detail} running={row.tools.some((x) => !x.result)}>
          {row.tools.map((x) => (
            <ToolRow key={x.key} tool={x} />
          ))}
        </Disclose>
      );
    }
    case 'task': {
      const k = row.tool;
      // The sub-agent's final result only; its internal steps stay in the terminal.
      const final = k.task?.text ?? (k.result ? outputText(k.result.output) : null);
      return (
        <Disclose tool id={row.key} label={taskLine(k)} detail={final === null ? t('chat.row.runningShort') : undefined} error={k.result?.is_error} running={final === null}>
          {final === null ? <p className="dim">{t('chat.row.running')}</p> : <Md text={final} />}
        </Disclose>
      );
    }
    case 'diff':
      return <Diff row={row} />;
    case 'orphan':
      return (
        <Disclose id={row.key} label={t('chat.row.toolResult')} detail={t('chat.row.orphan')} error={row.is_error}>
          <Capped id={row.key} text={outputText(row.output)} />
          <ClaudeLinkCards text={outputText(row.output)} />
        </Disclose>
      );
    case 'wakes':
      return <WakeLine n={row.n} team={row.team} />;
    case 'interrupted':
      return <div className="turnx dim">{t('chat.row.interrupted')}</div>;
    case 'shell': // ticket 1087
      return (
        <div className="shellrow">
          {row.command && (
            <div className="shc">
              <span className="shm" title={t('composer.shell')} aria-label={t('composer.shell')}>!</span>
              {row.command}
            </div>
          )}
          {row.output && <Capped id={row.key} text={plain(row.output)} />}
        </div>
      );
    case 'artifact': // v1b-06
      return <ArtifactCard session={session} data={row.data} newest={!row.older} />;
    case 'summary':
      return <Summary row={row} session={session} />;
    case 'changes':
      return <Changes row={row} />;
    case 'turnfiles': // ticket 222
      return <TurnFiles files={row.files} />;
  }
}
