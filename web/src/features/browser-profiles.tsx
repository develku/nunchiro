// Ticket 264 (needs 198, G05): Settings › In-app browser › Profiles. A profile is a cookie jar that spaces share (ego lite);
// the store is the core's `browser.profiles` feature, checked again by the app on every read (view.rs `Profiles`).
// Add, rename and set default are that feature. Clear and remove touch WebKit's store, so they are commands of this window
// only (browser/mod.rs), and each waits for the click on its sheet.
// The list and "Add profile" follow T3 Code (IntegrationsSettings.tsx:1358, AuthorizedClientsSettings.tsx:938, MIT License,
// Copyright (c) 2026 T3 Tools Inc.) and Orca (BrowserSessionCookiesSection.tsx:82, MIT License, Copyright (c) 2026 Lovecast
// Inc.): the list pattern and wording only; the rows are this app's row kit (final.html builders).
import { PLAIN } from '../plainText';
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { T } from '../i18n';
import { Icon } from '../icons/Icon';
import { StopAsk } from '../NewSession';
import { ErrorLine, rawError } from '../errors';
import { invoke } from '../pane/browser/control/bridge';
import { inApp } from '../pane/browser/view/bridge';
import { Row, Sec, Why } from '../settings/shell/Row';
import { useCoreFeature } from '../settings/useFeatureSetting';
import { PAGE, SECTIONS } from './browser-prefs';
import { registerSettingsSection } from './registry';

const BUILT_IN = 'default';
const ID = /^[a-z0-9-]{1,32}$/;
const NAME_MAX = 40;
const PROFILES_MAX = 16;

type Profile = { id: string; name: string };
type Stored = { default?: string; list?: Profile[] };
type Asked = { kind: 'clear' | 'remove'; profile: Profile };

/** The built-in profile first, then the stored rows the app would accept. */
const rowsOf = (s: Stored): Profile[] => {
  const list = (Array.isArray(s.list) ? s.list : []).filter((p) => !!p && ID.test(String(p.id)) && typeof p.name === 'string');
  return [list.find((p) => p.id === BUILT_IN) ?? { id: BUILT_IN, name: '' }, ...list.filter((p) => p.id !== BUILT_IN)];
};

// shortcut: layout only, inline (no colour or size), as browser-prefs.tsx; a stylesheet when this page has its own.
const LINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 };

function Profiles({ t }: { t: T }) {
  const [stored, setStored, readError] = useCoreFeature<Stored>('browser.profiles', {});
  const [live, setLive] = useState<Record<string, number>>({});
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const app = inApp();
  // A Remove answers later than its click: it builds on the value then, so a rename or Make default made meanwhile stays.
  const latest = useRef(stored);
  latest.current = stored;
  const rows = rowsOf(stored);
  const current = rows.some((p) => p.id === stored.default) ? stored.default! : BUILT_IN;
  const nameOf = (p: Profile) => p.name || t('bprofiles.builtIn');
  const full = rows.length >= PROFILES_MAX;

  const refresh = () => {
    if (!app) return;
    void invoke<{ list: (Profile & { live: number })[] } | null>('browser_profiles', { space: null })
      .then((r) => r && setLive(Object.fromEntries(r.list.map((p) => [p.id, p.live]))))
      .catch(() => {});
  };
  useEffect(refresh, [app]);

  const write = (list: Profile[], fallback = current) => setStored({ default: fallback, list: list.filter((p) => p.id !== BUILT_IN || p.name) });
  // The typed name goes only once the core took it: a refused write keeps it, with the error under the list.
  const add = (e: FormEvent) => {
    e.preventDefault();
    const name = draft.trim().slice(0, NAME_MAX);
    if (!name) return;
    void write([...rows, { id: `p-${crypto.randomUUID().slice(0, 8)}`, name }]).then((ok) => ok && (setDraft(''), setAdding(false)));
  };
  const rename = (p: Profile, text: string) => {
    const name = text.trim().slice(0, NAME_MAX);
    if (!name || name === p.name) return setRenaming(null);
    void write(rows.map((x) => (x.id === p.id ? { ...x, name } : x))).then((ok) => ok && setRenaming(null));
  };
  /** Runs only from the sheet's confirm button. */
  const confirm = ({ kind, profile }: Asked) => {
    setError('');
    invoke(kind === 'clear' ? 'browser_profile_clear' : 'browser_profile_remove', { profile: profile.id }).then(
      () => {
        setAsked(null);
        setDone(t(kind === 'clear' ? 'bprofiles.cleared' : 'bprofiles.removed', { name: nameOf(profile) }));
        // The app already wrote this list on a removal; the same value again keeps this page's copy in step.
        if (kind === 'remove') {
          const now = latest.current;
          const left = rowsOf(now).filter((p) => p.id !== profile.id);
          void setStored({ default: left.some((p) => p.id === now.default) ? now.default : BUILT_IN, list: left.filter((p) => p.id !== BUILT_IN || p.name) });
        }
        refresh();
      },
      (x) => setError(rawError(x)),
    );
  };

  return (
    <Sec
      id="h-bprofiles"
      title={t('bprofiles.title')}
      lede={
        <>
          {t('bprofiles.lede')}
          {full && <Why id="why-bprofiles-max" reason={t('settingsWhy.profilesMax', { n: PROFILES_MAX })} />}
        </>
      }
      action={
        <button type="button" className="btn withicon" data-setting="browserProfiles" aria-expanded={adding} disabled={full} aria-describedby={full ? 'why-bprofiles-max' : undefined} onClick={() => setAdding(!adding)}>
          <Icon name="plus" size={14} />
          {t('bprofiles.add')}
        </button>
      }
    >
      {rows.map((p) => {
        const open = live[p.id] ?? 0;
        // Ticket 475: Clear and Remove touch WebKit's store, which only the app has; Remove also waits for open spaces.
        const whyId = `why-bprofile-${p.id}`;
        const why = !app ? t('settingsWhy.needsApp') : open > 0 && p.id !== BUILT_IN ? t('bprofiles.removeBusy') : null;
        return (
          <Row
            key={p.id}
            setting={`browserProfile-${p.id}`}
            label={nameOf(p)}
            chip={p.id === current ? <span className="chip">{t('bprofiles.defaultChip')}</span> : undefined}
            desc={open ? t(open === 1 ? 'bprofiles.live1' : 'bprofiles.live', { n: open }) : t('bprofiles.idle')}
            why={why && <Why id={whyId} reason={why} />}
            control={
              <div style={LINE}>
                {renaming === p.id ? (
                  <input {...PLAIN}
                    className="search"
                    autoFocus
                    aria-label={t('bprofiles.renameLabel', { name: nameOf(p) })}
                    defaultValue={p.name}
                    maxLength={NAME_MAX}
                    onBlur={(e) => rename(p, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') rename(p, e.currentTarget.value);
                      if (e.key === 'Escape') (e.stopPropagation(), setRenaming(null));
                    }}
                  />
                ) : (
                  <button type="button" className="btn" aria-label={`${t('bprofiles.rename')}: ${nameOf(p)}`} onClick={() => setRenaming(p.id)}>
                    {t('bprofiles.rename')}
                  </button>
                )}
                {p.id !== current && (
                  <button type="button" className="btn" aria-label={`${t('bprofiles.makeDefault')}: ${nameOf(p)}`} onClick={() => void write(rows, p.id)}>
                    {t('bprofiles.makeDefault')}
                  </button>
                )}
                <button type="button" className="btn" aria-label={`${t('bprofiles.clear')}: ${nameOf(p)}`} disabled={!app} aria-describedby={!app ? whyId : undefined} onClick={() => (setError(''), setDone(''), setAsked({ kind: 'clear', profile: p }))}>
                  {t('bprofiles.clear')}
                </button>
                {p.id !== BUILT_IN && (
                  <button type="button" className="btn" aria-label={`${t('bprofiles.remove')}: ${nameOf(p)}`} disabled={!app || open > 0} aria-describedby={why ? whyId : undefined} onClick={() => (setError(''), setDone(''), setAsked({ kind: 'remove', profile: p }))}>
                    {t('bprofiles.remove')}
                  </button>
                )}
              </div>
            }
          />
        );
      })}
      {adding && (
        <Row
          label={t('bprofiles.nameLabel')}
          control={
            <form onSubmit={add} style={LINE}>
              <input {...PLAIN} className="search" autoFocus aria-label={t('bprofiles.nameLabel')} value={draft} maxLength={NAME_MAX} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setAdding(false))} />
              <button type="submit" className="btn" disabled={!draft.trim()} data-idle={!draft.trim() || undefined}>
                {t('bprofiles.addConfirm')}
              </button>
            </form>
          }
        />
      )}
      {(readError || (error && !asked)) && <ErrorLine t={t} error={readError || error} className="sds" />}
      {done && (
        <p className="sds" role="status">
          {done}
        </p>
      )}
      {asked && (
        <StopAsk
          name={nameOf(asked.profile)}
          error={error}
          onCancel={() => (setError(''), setAsked(null))}
          onStop={() => confirm(asked)}
          words={
            asked.kind === 'clear'
              ? { title: t('bprofiles.clearTitle', { name: nameOf(asked.profile) }), text: t('bprofiles.clearText'), cancel: t('bprofiles.keep'), stop: t('bprofiles.clearConfirm') }
              : { title: t('bprofiles.removeTitle', { name: nameOf(asked.profile) }), text: t('bprofiles.removeText'), cancel: t('bprofiles.keep'), stop: t('bprofiles.removeConfirm') }
          }
        />
      )}
    </Sec>
  );
}

registerSettingsSection({
  page: PAGE,
  id: SECTIONS.profiles,
  order: 30,
  fields: [{ key: 'browserProfiles', at: '[data-setting="browserProfiles"]' }],
  render: ({ t }) => <Profiles t={t} />,
});
