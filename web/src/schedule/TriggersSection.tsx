// Triggers (docs/triggers.md, docs/design/extensibility-m6 "Schedules 화면에 Triggers가 생깁니다"): under the Schedules
// list, each trigger with what fires it, who it starts, its last fire, Ask me first or Starts by itself, and its switch;
// Add trigger opens the form, the schedule form's fields with When for an event. The core owns all of it
// (crates/nunchiro-core/src/schedule/triggers.rs): the window is the owner and sends `{op: 'trigger', action}`.
import { PLAIN } from '../plainText';
import { useEffect, useState, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import { ErrorLine, knownOrRaw } from '../errors';
import type { Key, T } from '../i18n';
import { Select, Switch } from '../settings/shell/Row';
import { basename, isAccountTab } from '../tree';
import type { Session } from '../types';
import { dayWords } from './schedules';
import './triggers.css';

type Event = 'checks_failed' | 'changes_requested' | 'labeled';
interface Trigger {
  name: string;
  on: 'cli' | 'webhook' | 'github';
  run: { kind: string; project: string; task?: string };
  mode: 'ask' | 'auto';
  paused?: boolean;
  github?: { repo: string; event: Event; label?: string };
  last?: { at: number; result?: string; reason?: string };
}
/** The form's When: a GitHub event, a webhook or a command. */
type When = `github:${Event}` | 'webhook' | 'cli';
const WHENS: When[] = ['github:checks_failed', 'github:changes_requested', 'github:labeled', 'webhook', 'cli'];
// shortcut: the address shows the default port; settings.json `triggers_port` moves it, read it here when that is set.
const PORT = 47800;

const op = async (core: CoreClient, action: Record<string, unknown>) => ((await core.request({ op: 'trigger', action })) as { triggers: Trigger[] }).triggers;
/** A secret of 32 hex characters (128 bits), made in the window and shown once. */
const newSecret = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

function TriggerForm({ core, t, projects, onDone, onCancel }: { core: CoreClient; t: T; projects: string[]; onDone: (list: Trigger[], secret?: { name: string; secret: string }) => void; onCancel: () => void }) {
  const [when, setWhen] = useState<When>('github:checks_failed');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('claude');
  const [project, setProject] = useState(projects[0] ?? '');
  const [task, setTask] = useState('');
  const [mode, setMode] = useState<'ask' | 'auto'>('ask');
  const [repo, setRepo] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const event = when.startsWith('github:') ? (when.slice(7) as Event) : null;
  const ready = !!name && !!project && !!task.trim() && (!event || (/^[\w.-]+\/[\w.-]+$/.test(repo) && (event !== 'labeled' || !!label.trim())));
  const submit = async () => {
    if (!ready || busy) return;
    const secret = when === 'webhook' ? newSecret() : undefined;
    setBusy(true);
    setError(null);
    try {
      const list = await op(core, {
        do: 'add',
        name,
        on: event ? 'github' : when,
        run: { kind, project, label: name, task: task.trim() },
        mode,
        ...(secret ? { secret } : {}),
        ...(event ? { github: { repo, event, ...(event === 'labeled' ? { label: label.trim() } : {}) } } : {}),
      });
      onDone(list, secret ? { name, secret } : undefined);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  const field = (key: string, control: ReactNode, note?: ReactNode) => (
    <div className="sched-f">
      <span className="sched-k" aria-hidden>
        {key}
      </span>
      <div className="sched-c">{control}</div>
      {note && <div className="trig-note">{note}</div>}
    </div>
  );
  return (
    <form className="sched-form trig-form" aria-label={t('trigger.new')} aria-busy={busy || undefined} onSubmit={(e) => (e.preventDefault(), void submit())} onKeyDown={(e) => e.key === 'Escape' && !e.nativeEvent.isComposing && (e.stopPropagation(), onCancel())}>
      <h4>{t('trigger.new')}</h4>
      {field(
        t('trigger.when'),
        <Select label={t('trigger.when')} value={when} onChange={(v) => setWhen(v as When)}>
          {WHENS.map((w) => (
            <option key={w} value={w}>
              {t(`trigger.when.${w.replace('github:', 'github.')}` as Key)}
            </option>
          ))}
        </Select>,
      )}
      {event && field(t('trigger.repo'), <input {...PLAIN} aria-label={t('trigger.repo')} placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value.trim())} />, t('trigger.githubNote'))}
      {event === 'labeled' && field(t('trigger.label'), <input {...PLAIN} aria-label={t('trigger.label')} value={label} onChange={(e) => setLabel(e.target.value)} />)}
      {field(t('trigger.name'), <input {...PLAIN} aria-label={t('trigger.name')} placeholder="fix-checks" maxLength={64} value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))} />)}
      {field(
        t('schedule.kind'),
        <Select label={t('schedule.kind')} value={kind} onChange={setKind}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </Select>,
      )}
      {field(
        t('schedule.project'),
        projects.length ? (
          <Select label={t('schedule.project')} value={project} onChange={setProject}>
            {projects.map((p) => (
              <option key={p} value={p} title={p}>
                {basename(p)}
              </option>
            ))}
          </Select>
        ) : (
          <span className="trig-note">{t('trigger.noProject')}</span>
        ),
      )}
      {field(t('schedule.what'), <textarea {...PLAIN} rows={2} maxLength={4000} aria-label={t('schedule.what')} value={task} onChange={(e) => setTask(e.target.value)} />, t('trigger.taskNote'))}
      {field(
        t('trigger.before'),
        <Select label={t('trigger.before')} value={mode} onChange={(v) => setMode(v as 'ask' | 'auto')}>
          <option value="ask">{t('trigger.ask')}</option>
          <option value="auto">{t('trigger.autoLong')}</option>
        </Select>,
      )}
      {when === 'webhook' && field(t('trigger.address'), <code className="trig-code">{`http://127.0.0.1:${PORT}/hooks/${name || '<name>'}`}</code>, t('trigger.addressNote'))}
      {when === 'cli' && field(t('trigger.command'), <code className="trig-code">{`nunchiro trigger fire ${name || '<name>'} --data @file`}</code>)}
      <ErrorLine t={t} error={error} />
      <div className="sched-acts">
        <button type="submit" className="btn p" disabled={!ready} aria-busy={busy || undefined}>
          {t('schedule.card.add')}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t('team.cancel')}
        </button>
      </div>
    </form>
  );
}

export function TriggersSection({ core, t, sessions }: { core: CoreClient; t: T; sessions: Session[] }) {
  const [list, setList] = useState<Trigger[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState(false);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const act = async (action: Record<string, unknown>) => {
    setError(null);
    try {
      setList(await op(core, action));
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => void act({ do: 'list' }), [core]); // eslint-disable-line react-hooks/exhaustive-deps
  // The folders the core takes are the projects it knows, as the schedule form offers them.
  const projects = [...new Set(sessions.filter((s) => !isAccountTab(s) && !s.side_chat && !s.folder_gone).map((s) => s.project))].sort((a, b) => basename(a).localeCompare(basename(b)));
  const source = (x: Trigger) => (x.on === 'github' ? 'GitHub' : x.on === 'webhook' ? t('trigger.webhook') : t('trigger.cli'));
  return (
    <section className="trig" aria-labelledby="trig-h" data-triggers>
      <h4 className="trig-head" id="trig-h">
        {t('trigger.title')}
        <button type="button" className="btn" aria-expanded={form} onClick={() => (setSecret(null), setForm(!form))}>
          {t('trigger.add')}
        </button>
      </h4>
      <ErrorLine t={t} error={error} />
      {form && <TriggerForm core={core} t={t} projects={projects} onCancel={() => setForm(false)} onDone={(l, s) => (setList(l), setForm(false), setSecret(s ?? null))} />}
      {secret && (
        <div className="trig-secret" role="status" data-trigger-secret>
          <div className="trig-once">{t('trigger.secretOnce', { name: secret.name })}</div>
          <code className="trig-code">{secret.secret}</code>
          <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(secret.secret)}>
            {t('trigger.copy')}
          </button>
          <button type="button" className="btn q" onClick={() => setSecret(null)}>
            {t('trigger.done')}
          </button>
        </div>
      )}
      {list && !list.length && !form && <div className="trig-note" >{t('trigger.none')}</div>}
      {!!list?.length && (
        <ul className="trig-list" aria-label={t('trigger.title')}>
          {list.map((x) => {
            const fired = x.last ? `${t('trigger.lastFired', { when: dayWords(t, x.last.at) })}${x.last.result ? ` · ${t(`schedule.result.${x.last.result}` as Key)}` : ''}${x.last.reason ? `: ${knownOrRaw(t, x.last.reason)}` : ''}` : t('trigger.notFired');
            return (
              <li key={x.name} className="trig-row" data-trigger={x.name} data-paused={x.paused || undefined}>
                <span className="trig-name">
                  <b>{x.name}</b>
                  <span className="trig-meta">
                    {source(x)}
                    {x.github ? ` · ${x.github.repo}` : ''} · {basename(x.run.project)}
                  </span>
                </span>
                <span className="trig-meta">
                  {x.run.kind === 'codex' ? 'Codex' : 'Claude'} · “{x.run.task}”
                  <br />
                  {fired}
                </span>
                <span className="chip">{t(x.mode === 'auto' ? 'trigger.auto' : 'trigger.ask')}</span>
                <Switch checked={!x.paused} label={t('trigger.onOf', { name: x.name })} onChange={(on) => void act({ do: 'pause', name: x.name, paused: !on })} />
                {removing === x.name ? (
                  <span className="trig-acts" role="group" aria-label={t('trigger.removeAsk')}>
                    <button type="button" className="btn sdel" onClick={() => void act({ do: 'remove', name: x.name }).then(() => setRemoving(null))}>
                      {t('schedule.remove')}
                    </button>
                    <button type="button" className="btn" autoFocus onClick={() => setRemoving(null)}>
                      {t('team.cancel')}
                    </button>
                  </span>
                ) : (
                  <button type="button" className="btn q" aria-label={t('trigger.removeOf', { name: x.name })} onClick={() => setRemoving(x.name)}>
                    {t('schedule.remove')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
