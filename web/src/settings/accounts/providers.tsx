// Ticket 355, mockup C: the parts of Settings > Accounts that are not Claude's or Codex's own accounts: the add tiles, the
// one form that checks and approves an ACP entry (it replaced the Agents page's setup sheet, V2-4b).
// The form's promises stay the sheet's: the exact command and env names are shown, the core's confined check runs
// before approval, and "Approve and add" compares what the core stored with what was shown before it grants that hash
// (threat 1). Only variable names are ever saved: a value typed into the name field is refused and cleared, never echoed.
import { PLAIN } from '../../plainText';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AcpCheck, AcpEntry, AcpRow, AgentView, CoreClient } from '../../api';
import type { Key } from '../../i18n';
import { Icon } from '../../icons/Icon';
import { ENV_NAME, escaped, hasControl, joinWords, splitWords, validAgentName } from '../agents/words';
import { ErrorDetails, ErrorLine, plainError, rawError } from '../../errors';
import { AcpLogin } from './acpSignIn';
import { validName } from './sections';

export type T = (key: Key, args?: Record<string, string | number>) => string;
const message = (e: unknown) => rawError(e);
const same = (a: AcpEntry, b: AcpEntry) => a.name === b.name && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args) && JSON.stringify(a.env) === JSON.stringify(b.env);
const composing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

/** Colour logos are held (V2.5-2): a bordered monogram. Two letters where one would repeat (Gemini, goose, Grok). */
const MONOGRAM: Record<string, string> = { claude: 'C', codex: 'X', gemini: 'Gm', opencode: 'O', goose: 'Gs', aider: 'A', cursor: 'Cu', grok: 'Gk', antigravity: 'Ag', muse: 'Mc', pi: 'Pi' };
export const Mark = ({ name, service }: { name: string; service?: boolean }) => (
  <span className="prv-mark" aria-hidden="true">
    {service ? (
      <svg className="mg-key" viewBox="0 0 16 16">
        <circle cx="5.5" cy="10.5" r="3" />
        <path d="M7.7 8.3 13.5 2.5M11 5l2 2" />
      </svg>
    ) : (
      (MONOGRAM[name] ?? name.slice(0, 1).toUpperCase())
    )}
  </span>
);
export const Chip = ({ word, tone = '' }: { word: string; tone?: '' | 'ok' | 'warn' | 'bad' | 'plain' }) => <span className={`pchip ${tone}`}>{word}</span>;
export const Ln = ({ k, children, sp, id, reset }: { k: ReactNode; children: ReactNode; sp?: boolean; id?: string; reset?: ReactNode }) => (
  <div className={`prv-ln${sp ? ' sp' : ''}`}>
    <span className="prv-k">
      <span id={id}>{k}</span>
      {reset}
    </span>
    <span className="prv-v">{children}</span>
  </div>
);

/** The agents that have no confirmed ACP switch: the tile opens the tool's install page, when one is confirmed, and the form. */
export const UNCONFIRMED: { name: string; label: string; url?: string; docs?: string; source?: string }[] = [
  { name: 'muse', label: 'Muse Code' },
  { name: 'pi', label: 'Pi', url: 'https://pi.dev', docs: 'https://pi.dev/docs/latest', source: 'https://github.com/earendil-works/pi' },
];
export const AGENT_TILES = ['gemini', 'opencode', 'goose', 'aider', 'cursor', 'grok', 'antigravity', 'muse', 'pi'];
export const KEY_TILES = ['openrouter', 'glm', 'kimi'];

/** The how-to is one true sentence: the core imports no shell environment (main.rs `core_command`; `login_path` only feeds the
 *  CLI install hint) and keeps the environment it started with, so the variable needs launchd and a full quit. */
export function MissingVars({ t, names, primary }: { t: T; names: string[]; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!names.length) return null;
  return (
    <div className="fx-wrap">
      <div className="prv-fx" data-field="env-missing">
        <span className="prv-tx">
          {names.map((n) => (
            <span key={n}>
              <code className="mono">{n}</code> {t('providers.missing')}{' '}
            </span>
          ))}
        </span>
        <button type="button" className={`btn${primary ? ' p' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('providers.howTo')}
        </button>
      </div>
      {open && (
        <p className="howto" data-field="env-howto">
          {t('providers.howToLine', { name: names[0], quit: t('settings.lifetime.quit') })}
        </p>
      )}
    </div>
  );
}

export const missingOf = (names: string[], set?: Record<string, boolean>) => names.filter((n) => set?.[n] === false);

/** `row` null is 직접 입력; `start` fills a blank form (a tile with no known entry). An approved row is edited here and any
 *  change is added, checked and approved again; a row awaiting approval is shown as the file holds it and runs only on a click. */
export function ProviderForm({ t, core, row, start, taken, onClose, onApproved }: { t: T; core: CoreClient; row: AcpRow | null; start?: { name: string; label: string }; taken: string[]; onClose: () => void; onApproved: (view: AgentView) => void }) {
  const review = row?.state != null && row.state !== 'approved';
  const preset = row?.state == null && !!row;
  const label = row?.label ?? start?.label ?? t('providers.custom');
  const [name, setName] = useState(row?.name ?? start?.name ?? '');
  const [display, setDisplay] = useState(row?.label ?? start?.label ?? '');
  const [line, setLine] = useState(() => (row ? joinWords([row.found_path && !row.command.includes('/') ? row.found_path : row.command, ...row.args]) : ''));
  const [env, setEnv] = useState<string[]>(row?.env ?? []);
  const [envText, setEnvText] = useState('');
  const [envError, setEnvError] = useState('');
  const [check, setCheck] = useState<AcpCheck | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(''); // ticket 476: a failure's raw reason, under Details
  const fail = (e: unknown) => (setError(plainError(t, e)), setDetails(message(e)));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const words = review ? null : splitWords(line);
  // Emptied, it is removed; left as the tool's own name, none is stored.
  const shownName = display.trim();
  const named = shownName && (shownName !== (row?.label ?? start?.label) || row?.display) ? { display: shownName } : {};
  const entry: AcpEntry | null = review ? { name: row.name, command: row.command, args: row.args, env: row.env } : words?.length ? { name, command: words[0], args: words.slice(1), env, ...named } : null;
  const problem = (() => {
    if (review) return '';
    if (shownName && !validName(shownName)) return t('providersFailed.displayRule');
    if (words === null) return t('agents.sheet.unclosed');
    if (!row && taken.includes(name)) return t('providers.nameTaken');
    if (!words.length) return '';
    if (!words[0].startsWith('/')) return t('agents.sheet.fullPath');
    if (words.some(hasControl)) return t('agents.sheet.control');
    if (!validAgentName(name)) return name ? t('agents.sheet.nameRule') : '';
    return '';
  })();
  const ready = !!entry && !problem && validAgentName(entry.name);
  // The display name is left out: it is no part of what a check runs or an approval covers.
  const key = ready ? JSON.stringify({ ...entry, display: undefined }) : '';
  const nameOnly = ready && row?.state === 'approved' && same(entry, { ...row, display: undefined }) && (entry.display ?? '') !== (row.display ?? '');
  const seq = useRef(0);
  const run = useCallback(
    async (e: AcpEntry, confirmed: boolean) => {
      const id = ++seq.current;
      setRunning(true);
      for (let tries = 0; ; tries++) {
        try {
          const r = await core.acpCheck(e, confirmed);
          if (id !== seq.current) return;
          setCheck(r);
          break;
        } catch (err) {
          // The core runs one check at a time.
          if (/a check is running/.test(message(err)) && tries < 10 && id === seq.current) {
            await new Promise((r) => setTimeout(r, 700));
            continue;
          }
          if (id !== seq.current) return;
          setCheck({ found_path: null, version: null, acp_v1_ms: null, capabilities: [], signed_in: null, error: message(err) });
          break;
        }
      }
      if (id === seq.current) setRunning(false);
    },
    [core],
  );
  // A change drops the old result. A check runs only on the owner's click: nothing typed, unread or merely first on the PATH
  // (Cursor's command is the generic name `agent`) runs by itself.
  useEffect(() => {
    seq.current++;
    setCheck(null);
    setRunning(false);
  }, [key]);
  useEffect(() => {
    root.current?.scrollIntoView?.({ block: 'nearest' });
    if (!preset) root.current?.querySelector<HTMLElement>('input:not([readonly]), textarea:not([readonly])')?.focus();
  }, [preset]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  });

  /** A name is uppercase letters, digits and `_`. Anything else may be the key itself: refused, cleared, not repeated. */
  const addEnv = () => {
    const n = envText.trim();
    if (!n) return;
    setEnvText('');
    if (!ENV_NAME.test(n) || n.length > 128) return setEnvError(t('agents.sheet.envRule'));
    if (!env.includes(n)) setEnv([...env, n]);
    setEnvError('');
  };
  const approve = async () => {
    if (!entry || !ready || busy) return;
    const shown: AcpEntry = { ...entry, args: [...entry.args], env: [...entry.env] };
    setBusy(true);
    setError('');
    setDetails('');
    try {
      const view = review ? await core.acpStatus(shown.name) : await core.acpAdd(shown);
      if (!same(view.entry, shown)) return setError(t('agents.sheet.changed'));
      if (view.refused) return fail(view.refused);
      onApproved(await core.acpGrant(view.name, view.hash));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  /** Only the display name changed: stored as it is, with no check and no new approval (the hash does not cover it). */
  const saveName = async () => {
    if (!entry || busy) return;
    setBusy(true);
    setError('');
    setDetails('');
    try {
      onApproved(await core.acpAdd(entry));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const login = async () => {
    setError('');
    setDetails('');
    setNote('');
    try {
      const sessions = ((await core.request({ op: 'snapshot' })) as { sessions: { project: string; attention: { last_activity: number } }[] }).sessions;
      const project = [...sessions].sort((a, b) => b.attention.last_activity - a.attention.last_activity)[0]?.project;
      if (!project) return setError(t('agents.sheet.startFirst'));
      if (!entry) return;
      const { session } = await core.acpLogin(entry.name, project);
      setNote(t('agents.sheet.loginOpened', { tab: session.label }));
    } catch (e) {
      if (/approve the agent first/.test(message(e))) setError(t('agents.sheet.approveFirst'));
      else fail(e);
    }
  };

  const done = !!check && !running;
  const spoke = done && !!check.found_path && check.acp_v1_ms !== null;
  const missing = done ? missingOf(entry?.env ?? [], check.env_set) : [];
  const refused = row?.refused ?? null;
  const signedOut = done && check.signed_in === false;
  // The check has to have run and spoken ACP; a missing variable or sign-in is shown, and the row keeps saying so once added.
  const canApprove = spoke && !refused && ready && !busy && !nameOnly;
  const commandLine = review && entry ? escaped(joinWords([entry.command, ...entry.args])) : line;
  const version = (check?.version ?? '').trim();
  return (
    <div
      ref={root}
      className="prv-exp f"
      role="group"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !composing(e)) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {row?.state === 'changed' && (
        <p role="status" className="prv-note">
          {t('agents.sheet.changedSince')}
        </p>
      )}
      <Ln k={<label htmlFor="pv-name">{t('providers.name')}</label>}>
        <input {...PLAIN} id="pv-name" className="prv-inp mono w" value={name} readOnly={!!row} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)} />
      </Ln>
      <Ln k={<label htmlFor="pv-display">{t('providersFailed.displayName')}</label>}>
        <input {...PLAIN} id="pv-display" className="prv-inp w" value={display} readOnly={review} autoComplete="off" spellCheck={false} onChange={(e) => setDisplay(e.target.value)} />
      </Ln>
      <Ln k={<label htmlFor="pv-command">{t('providers.command')}</label>}>
        <textarea {...PLAIN}
          id="pv-command"
          ref={box}
          className="prv-inp mono w"
          rows={1}
          value={commandLine}
          readOnly={review}
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(e) => e.key === 'Enter' && !composing(e) && e.preventDefault()}
          onChange={(e) => setLine(e.target.value.replace(/[\r\n]+/g, ' '))}
        />
      </Ln>
      <Ln k={t('providers.envNames')}>
        {env.map((n) => (
          <span key={n} className="prv-tag">
            {n}
            {!review && (
              <button type="button" aria-label={t('agents.sheet.remove', { name: n })} onClick={() => setEnv(env.filter((x) => x !== n))}>
                ×
              </button>
            )}
          </span>
        ))}
        {!review && (
          <input {...PLAIN}
            className="prv-inp mono envin"
            aria-label={t('providers.envNames')}
            placeholder={t('providers.envAdd')}
            value={envText}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => (setEnvText(e.target.value), setEnvError(''))}
            onBlur={addEnv}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ',') && !composing(e)) (e.preventDefault(), addEnv());
            }}
          />
        )}
      </Ln>
      <div className="prv-note">{t('providers.envNote')}</div>
      {envError && (
        <p role="alert" className="prv-note bad" data-field="env-error">
          {envError}
        </p>
      )}
      <Ln k={t('providers.result')} sp>
        <span data-field="check-result">
          {running ? <Chip word={t('agents.sheet.testing')} /> : !check ? <Chip word={t('providers.unchecked')} /> : !spoke ? <Chip word={t('providers.failed')} tone="bad" /> : missing.length ? <Chip word={t('providers.varMissing')} tone="warn" /> : signedOut ? <Chip word={t('providers.needsLogin')} tone="warn" /> : <Chip word={t('providers.passed')} tone="ok" />}
        </span>
        {spoke && <small>{`${version ? `${version} · ` : ''}ACP v1`}</small>}
        <span className="prv-end">
          {signedOut && (
            <button type="button" className="btn" onClick={() => void login()}>
              {t('agents.sheet.loginTab')}
            </button>
          )}
          <button type="button" className="btn" disabled={running || !ready} onClick={() => entry && ready && void run(entry, review)}>
            {t(check ? 'providers.checkAgain' : 'providers.check')}
          </button>
        </span>
      </Ln>
      {/* The agent program's own output: never matched to a sentence about Nunchiro. */}
      {done && <ErrorLine t={t} error={check.error} className="prv-note" field="check-error" foreign />}
      <MissingVars t={t} names={missing} />
      {problem && (
        <p role="alert" className="prv-note bad" data-field="entry-problem">
          {problem}
        </p>
      )}
      {refused && (
        <p role="alert" className="prv-note bad" data-field="refused">
          {refused}
        </p>
      )}
      {note && (
        <p role="status" className="prv-note">
          {note}
        </p>
      )}
      {error && (
        <div role="alert" className="prv-note bad" data-field="error">
          {error}
          <ErrorDetails t={t} details={details} />
        </div>
      )}
      <div className="acts2">
        {nameOnly && (
          <button type="button" className="btn p" aria-busy={busy} onClick={() => void saveName()}>
            {t('providersFailed.save')}
          </button>
        )}
        {canApprove && (
          <button type="button" className="btn p" aria-busy={busy} onClick={() => void approve()}>
            {t('providers.approve')}
          </button>
        )}
        <button type="button" className="btn" onClick={onClose}>
          {t('providers.cancel')}
        </button>
      </div>
      {row && <AcpLogin t={t} core={core} row={row} />}
    </div>
  );
}

export const Chevron = ({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) => (
  <button type="button" className={`prv-chv${open ? ' up' : ''}`} aria-expanded={open} aria-label={label} onClick={onClick}>
    <Icon name="chevron-down" size={12} />
  </button>
);
