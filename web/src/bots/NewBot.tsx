// A bot in one minute (owner-approved mockup docs/design/bots-1166.html, panel 3, the left window): a name and one
// sentence. The face is given and a press changes it; six templates fill the sentence; the agent and the model are one
// line ("Runs on Claude Code · follows its newest model") until Change opens them. Create makes the bot in one step
// (`bot_new`) and opens its chat, where the first chat goes on (FirstChat.tsx). A Lead or Chief template seats nobody
// here: the first chat asks where the bot sits.
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { CoreClient } from '../api';
import { ErrorLine, rawError } from '../errors';
import { MatePicks } from '../features/team';
import type { T } from '../i18n';
import { openSeat, setTeam, useTeam, type Team } from '../lead/lead';
import { pairText } from '../lead/level';
import { PLAIN } from '../plainText';
import { Select } from '../settings/shell/Row';
import { basename } from '../tree';
import { freeFace, onNewBot, openBots, type BotFace } from './bots';
import { Face } from './Face';
import './bots.css';

/** The six starts. A template is its sentence; `seat` is the seat the first chat then asks about. */
export const TEMPLATES = [{ key: 'lead', seat: 'lead' }, { key: 'reviewer' }, { key: 'notes' }, { key: 'chief', seat: 'chief' }, { key: 'peer' }, { key: 'docs' }] as const;
type Kind = 'claude' | 'codex' | 'acp';
type Picks = { kind: Kind; agent?: string; model: string; effort: string };
const agentWord = (p: Picks) => (p.kind === 'claude' ? 'Claude Code' : p.kind === 'codex' ? 'Codex' : (p.agent ?? 'ACP')); // program names, not words

type Props = { core: CoreClient; t: T; projects: string[]; front: string | null; open: (id: string) => void };

/** Mounted once by the window; shown when the Bots view or the palette asks (`askNewBot`). */
export function NewBot(props: Props) {
  const [n, setN] = useState(0);
  const [shown, setShown] = useState(false);
  useEffect(() => onNewBot(() => (setN((x) => x + 1), setShown(true))), []);
  return shown ? <Dialog key={n} {...props} onClose={() => setShown(false)} /> : null;
}

function Dialog({ core, t, projects: listed, front, open, onClose }: Props & { onClose: () => void }) {
  const team = useTeam(core, true);
  const projects = listed.filter((p) => p !== team.home); // Home's own folder is no project: it is the first choice below
  const taken = useMemo(() => (team.bots ?? []).map((b) => b.face), [team.bots]);
  const [face, setFace] = useState<BotFace>(() => freeFace(taken, Math.floor(Math.random() * 36)));
  const [name, setName] = useState('');
  const [job, setJob] = useState('');
  const [picks, setPicks] = useState<Picks>({ kind: 'claude', agent: '', model: '', effort: '' });
  // A bot works where it is made: the project in front, or Home when none is.
  const [picked, setPlace] = useState(front ?? '');
  const place = projects.includes(picked) ? picked : '';
  const [change, setChange] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>('');
  const box = useRef<HTMLFormElement>(null);
  const sentence = useRef<HTMLTextAreaElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    const prev = back.current;
    return () => (prev as HTMLElement | null)?.focus?.();
  }, []);
  // The chip that is on is the one whose sentence stands in the field: an edited sentence is no template any more.
  const on = TEMPLATES.find((tp) => t(`bots.tpl.${tp.key}.job`) === job.trim());
  const ready = !!name.trim() && !!job.trim() && !busy;
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    let made: string | undefined;
    try {
      const got = (await core.request({
        op: 'bot_new',
        name: name.trim(),
        job: job.trim(),
        kind: picks.kind,
        ...(picks.kind === 'acp' && picks.agent ? { agent: picks.agent } : {}),
        ...(picks.model ? { model: picks.model } : {}),
        ...(picks.effort ? { effort: picks.effort } : {}),
        ...(place ? { project: place } : {}),
        face,
        ...(on && 'seat' in on ? { seat: on.seat } : {}),
      })) as Team & { made?: string };
      setTeam(got);
      made = got.made;
    } catch (err) {
      setError(err);
      setBusy(false);
      return;
    }
    onClose();
    if (!made) return;
    // The bot is made either way: a chat that cannot open (no agent on this Mac) leaves the owner on the bot's page.
    await openSeat(core, made).then(
      ({ session }) => open(session.id),
      () => openBots(made),
    );
  };
  const key = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), onClose());
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return (e.preventDefault(), void submit());
    if (e.key !== 'Tab') return;
    // Tab stays in the dialog.
    const all = [...(box.current?.querySelectorAll<HTMLElement>('button, input, textarea, select') ?? [])].filter((x) => !(x as HTMLButtonElement).disabled);
    const i = all.indexOf(document.activeElement as HTMLElement);
    const next = all[(i + (e.shiftKey ? -1 : 1) + all.length) % all.length];
    if (i < 0 || (e.shiftKey ? i === 0 : i === all.length - 1)) (e.preventDefault(), next?.focus());
  };
  const model = picks.model ? t('bots.new.pinned', { model: pairText(t, picks.kind, { model: picks.model, effort: picks.effort || null }, { agent: picks.agent }) }) : t('bots.new.follows');
  return (
    // A press beside the dialog closes it only while nothing is typed: words are never lost to a stray click.
    <div className="rmscrim" onPointerDown={(e) => e.target === e.currentTarget && !name && !job && onClose()}>
      <form ref={box} className="newbot" data-new-bot data-tile={face.tile} role="dialog" aria-modal="true" aria-label={t('bots.new.title')} aria-busy={busy || undefined} onSubmit={(e) => void submit(e)} onKeyDown={key}>
        <h2>{t('bots.new.title')}</h2>
        <div className="nb-id">
          <button type="button" className="nb-face" data-new-face aria-label={t('bots.new.face')} onClick={() => setFace(freeFace(taken, face))}>
            <Face t={t} face={face} name={name.trim() || t('bots.new.title')} eyes="rest" size={56} />
          </button>
          <div>
            <input {...PLAIN} className="nb-name" aria-label={t('bots.new.name')} placeholder={t('bots.new.name')} value={name} maxLength={40} autoFocus autoComplete="off" spellCheck={false} disabled={busy} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing && (e.preventDefault(), sentence.current?.focus())} />
            <div className="nb-hint">{t('bots.new.faceHint')}</div>
          </div>
        </div>
        <textarea ref={sentence} className="nb-job" aria-label={t('bots.new.job')} placeholder={t('bots.new.jobPh')} value={job} maxLength={2000} rows={2} disabled={busy} onChange={(e) => setJob(e.target.value)} />
        <div className="nb-lab" id="nb-from">
          {t('bots.new.from')}
        </div>
        <div className="nb-tpl" role="group" aria-labelledby="nb-from">
          {TEMPLATES.map((tp) => (
            <button type="button" key={tp.key} data-template={tp.key} aria-pressed={on?.key === tp.key} disabled={busy} onClick={() => setJob(t(`bots.tpl.${tp.key}.job`))}>
              {t(`bots.tpl.${tp.key}`)}
            </button>
          ))}
        </div>
        <div className="nb-runs" data-new-runs>
          <span>
            {place ? t('bots.new.runsIn', { agent: agentWord(picks), project: basename(place) }) : t('bots.new.runs', { agent: agentWord(picks) })} · {model}
          </span>
          <button type="button" className="nb-link" aria-expanded={change} disabled={busy} onClick={() => setChange(!change)}>
            {t('bots.new.change')}
          </button>
        </div>
        {change && (
          <div className="nb-picks">
            <MatePicks t={t} core={core} draft={picks} setDraft={setPicks} />
            <label>
              <span>{t('bots.new.place')}</span>
              <Select label={t('bots.new.place')} value={place} onChange={setPlace}>
                <option value="">{t('bots.new.home')}</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {basename(p)}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        )}
        <ErrorLine t={t} error={error ? rawError(error) : ''} />
        <div className="nb-foot">
          <button type="button" className="nb-btn quiet" onClick={onClose}>
            {t('bots.new.cancel')}
          </button>
          <button type="submit" className="nb-btn primary" data-new-create disabled={!ready}>
            {t('bots.new.create')} <kbd>⌘↩</kbd>
          </button>
        </div>
      </form>
    </div>
  );
}
