// Ticket 358 (327): Claude's and Codex's own command on Settings > Accounts, the row and its edit form (mock #edit, #pathedit).
// A confined `--version` runs on the owner's click and 승인하고 저장 appears only after it passes; the grant quotes the hash that
// check returned, so the core approves exactly what the form showed. Only variable names are saved: a value typed into the
// name field is refused and cleared, never echoed.
import { PLAIN } from '../../plainText';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AccountAgent, CommandCheck, CommandView, CoreClient } from '../../api';
import { ENV_NAME, hasControl, joinWords, splitWords } from '../agents/words';
import { ErrorLine } from '../../errors';
import { tilde, Why, WhyFix } from '../shell/Row';
import { Chip, Ln, MissingVars, missingOf, type T } from './providers';

const composing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

function CommandForm({ t, core, agent, view, found, onSaved, onClose }: { t: T; core: CoreClient; agent: AccountAgent; view: CommandView; found: string | null; onSaved: (view: CommandView) => void; onClose: () => void }) {
  const from = view.pending ?? view.approved;
  const [path, setPath] = useState(from?.command ?? found ?? '');
  const [line, setLine] = useState(joinWords(from?.args ?? []));
  const [env, setEnv] = useState<string[]>(from?.env ?? []);
  const [envText, setEnvText] = useState('');
  const [envError, setEnvError] = useState('');
  const [check, setCheck] = useState<CommandCheck | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>('');
  const root = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  // Q9 en-b-J14-1: a check that passed in this form left a held command, even after an edit or a later failed check.
  const held = useRef(false);

  const args = splitWords(line);
  const problem = args === null ? t('agents.sheet.unclosed') : path && !path.startsWith('/') ? t('agents.sheet.fullPath') : hasControl(path) || args.some(hasControl) ? t('agents.sheet.control') : '';
  const ready = !!path && !problem && !!args;
  const key = JSON.stringify([path, args, env]);
  // A change drops the old result, so the button can never approve something other than what was checked.
  useEffect(() => {
    seq.current++;
    setCheck(null);
    setRunning(false);
  }, [key]);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('input')?.focus();
  }, []);

  const runCheck = useCallback(async () => {
    if (!args) return;
    const id = ++seq.current;
    setRunning(true);
    setError('');
    try {
      const result = await core.commandCheck(agent, path, args, env);
      if (result.hash) held.current = true;
      if (id === seq.current) setCheck(result);
    } catch (e) {
      if (id === seq.current) setError(e);
    } finally {
      if (id === seq.current) setRunning(false);
    }
  }, [core, agent, path, args, env, t]);

  /** Runs one core write; `done` gets the new view. */
  const write = async (call: () => Promise<CommandView>, done: (next: CommandView) => void) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      done(await call());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  // A check that passed left a held command in the core: leaving by Cancel drops it. Leaving the row keeps it, and it says so.
  const cancel = () => (view.pending || held.current ? void write(() => core.commandReset(agent, true), (next) => (onSaved(next), onClose())) : onClose());
  const addEnv = () => {
    const name = envText.trim();
    if (!name) return;
    setEnvText('');
    if (!ENV_NAME.test(name) || name.length > 128) return setEnvError(t('agents.sheet.envRule'));
    if (!env.includes(name)) setEnv([...env, name]);
    setEnvError('');
  };
  const missing = check ? missingOf(env, check.env_set) : [];
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && !composing(e)) {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };
  return (
    <div ref={root} role="group" aria-label={t('providers.path')} onKeyDown={onKey}>
      <Ln k={<label htmlFor={`cmd-path-${agent}`}>{t('providers.cmd.path')}</label>} sp>
        <input {...PLAIN} id={`cmd-path-${agent}`} className="prv-inp mono w" value={path} autoComplete="off" spellCheck={false} onChange={(e) => setPath(e.target.value)} />
      </Ln>
      <Ln k={<label htmlFor={`cmd-args-${agent}`}>{t('providers.cmd.args')}</label>}>
        <input {...PLAIN} id={`cmd-args-${agent}`} className="prv-inp mono w" value={line} autoComplete="off" spellCheck={false} onChange={(e) => setLine(e.target.value)} />
      </Ln>
      <Ln k={t('providers.envNames')}>
        {env.map((name) => (
          <span key={name} className="prv-tag">
            {name}
            <button type="button" aria-label={t('agents.sheet.remove', { name })} onClick={() => setEnv(env.filter((x) => x !== name))}>
              ×
            </button>
          </span>
        ))}
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
      </Ln>
      <div className="prv-note">
        {t('providers.envNote')} {t('providers.cmd.envOnly')}
      </div>
      {envError && (
        <p role="alert" className="prv-note bad" data-field="env-error">
          {envError}
        </p>
      )}
      <Ln k={t('providers.result')} sp>
        <span data-field="check-result">{running ? <Chip word={t('agents.sheet.testing')} /> : !check ? <Chip word={t('providers.unchecked')} /> : check.hash ? <Chip word={t('providers.passed')} tone="ok" /> : <Chip word={t('providers.failed')} tone="bad" />}</span>
        {check?.version && <small>{check.version}</small>}
        <span className="prv-end">
          {/* Ticket 543: a path or arguments the core would refuse say why on the line under; an empty path only waits for typing. */}
          <button type="button" className="btn" disabled={running || !ready} aria-busy={running || undefined} aria-describedby={problem ? `why-cmd-${agent}` : undefined} data-idle={(!running && !ready && !problem) || undefined} onClick={() => void runCheck()}>
            {t(check ? 'providers.checkAgain' : 'providers.check')}
          </button>
        </span>
      </Ln>
      {/* The agent program's own output: never matched to a sentence about Nunchiro. */}
      <ErrorLine t={t} error={check?.error} className="prv-note" field="check-error" foreign />
      <MissingVars t={t} names={missing} />
      {problem && (
        <p role="alert" className="prv-note bad" data-field="entry-problem">
          <Why id={`why-cmd-${agent}`} reason={problem} />
        </p>
      )}
      <ErrorLine t={t} error={error} className="prv-note bad" field="error" />
      <div className="prv-note">{t('providers.cmd.again')}</div>
      <div className="acts2">
        {check?.hash && !running && (
          <button type="button" className="btn p" aria-busy={busy} onClick={() => void write(() => core.commandGrant(agent, check.hash!), (next) => (onSaved(next), onClose()))}>
            {t('providers.cmd.approve')}
          </button>
        )}
        <button type="button" className="btn" onClick={cancel}>
          {t('providers.cancel')}
        </button>
        <button type="button" className="btn prv-ghost flush cmd-reset" onClick={() => void write(() => core.commandReset(agent), (next) => (onSaved(next), onClose()))}>
          {t('providers.cmd.reset')}
        </button>
      </div>
    </div>
  );
}

/** 경로: what new sessions run. `found` is the agent on PATH, shown while no approved command replaces it. */
export function AgentCommandRow({ t, core, agent, found, onView }: { t: T; core: CoreClient; agent: AccountAgent; found: string | null; onView?: (view: CommandView) => void }) {
  const [view, show] = useState<CommandView | null>(null);
  const [reads, again] = useState(0); // Retry after a failed first read
  // Ticket 391: the card head shows whether the command has arguments, so a saved change goes there too.
  const setView = (next: CommandView) => (show(next), onView?.(next));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<unknown>('');
  useEffect(() => {
    let live = true;
    core.commandStatus(agent).then(
      (next) => live && (setView(next), setError('')),
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
    // `t` changes identity with the language; the status does not depend on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core, agent, reads]);

  const shown = view?.approved ?? null;
  const refused = view?.state === 'changed' || view?.state === 'unapproved';
  const args = shown?.args ?? [];
  return (
    <div data-field="command" data-agent={agent}>
      {editing && view ? (
        <CommandForm t={t} core={core} agent={agent} view={view} found={found} onSaved={setView} onClose={() => setEditing(false)} />
      ) : (
        <>
          <Ln k={t('providers.path')} sp>
            <span className="mono" title={shown?.command ?? found ?? undefined}>{tilde(shown?.command ?? found ?? '')}</span>
            {args.length ? <span className="mono">{joinWords(args)}</span> : <small>{t('providers.noArgs')}</small>}
            {view?.pending && <Chip word={t('providers.needsApproval')} tone="warn" />}
            <span className="prv-end">
              {/* Ticket 543: still reading is a wait (aria-busy); a failed read says so and offers Retry. */}
              <button type="button" className="btn" disabled={!view} aria-busy={(!view && !error) || undefined} aria-describedby={!view && error ? `why-cmd-read-${agent}` : undefined} onClick={() => setEditing(true)}>
                {t('providers.change')}
              </button>
            </span>
          </Ln>
          {!view && !!error && (
            <p className="prv-note bad">
              <Why id={`why-cmd-read-${agent}`} reason={t('settingsWhy.commandUnread')} fix={<WhyFix label={t('settings.kit.retry')} run={() => again((n) => n + 1)} />} />
            </p>
          )}
          {refused && (
            <p role="alert" className="prv-note bad" data-field="command-refused">
              {t('providers.cmd.refused')}
            </p>
          )}
          {view?.pending && (
            <div className="prv-note" data-field="command-pending">
              {t('providers.cmd.pending', { command: joinWords([view.pending.command, ...view.pending.args]) })}
            </div>
          )}
          {agent === 'codex' && view?.state === 'approved' && args.length > 0 && (
            <div className="prv-note" data-field="codex-args-note">
              {t('providers.cmd.codexArgs')}
            </div>
          )}
          {shown && view && <MissingVars t={t} names={missingOf(shown.env, view.env_set)} />}
        </>
      )}
      <ErrorLine t={t} error={error} className="prv-note bad" field="error" />
    </div>
  );
}
