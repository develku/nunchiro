// Onboarding step "Pick your keys" (owner 2026-11-16): the prefix and the hint letters, set in the panel with the Keyboard
// page's own recorder, conflict rules and alphabet field (keys/apply.ts, Recorder.tsx, HintAlphabet.tsx).
import { useEffect, useRef, useState } from 'react';
import type { PageContext } from '../../features/registry';
import { commandTitle } from '../../i18n/lib/commandTitle';
import { label, merge } from '../../keys';
import { around } from '../../i18n';
import { Chord } from '../keys/KeysPage';
import { resetClash, withBindings, withDefaults, withSlot } from '../keys/apply';
import { AlphabetField, useHintAlphabet } from '../keys/HintAlphabet';
import { Caps, RecordingCells, ResetAsk } from '../keys/Recorder';
import { Reset, Row } from '../shell/Row';
import '../keys/keys-list.css';

const ID = 'prefix';

export function KeysStep({ t, settings, commands, update }: Pick<PageContext, 't' | 'settings' | 'commands' | 'update'>) {
  const overrides = settings.bindings;
  const bindings = merge(overrides);
  const slots = bindings[ID] ?? [];
  // Recording a chord, or a reset that asks Replace first (another command took the default since).
  const [edit, setEdit] = useState<'record' | { clash: string[]; taken: string[] } | null>(null);
  const store = (next: typeof overrides) => (update({ bindings: next }), setEdit(null));
  const reset = () => {
    const ask = resetClash(bindings, ID, [ID]);
    if (ask.clash.length) return setEdit(ask);
    store(withDefaults(overrides, bindings, [ID], [], ask.taken));
  };
  const titleOf = (id: string) => commandTitle(t, id, commands.find((c) => c.id === id)?.title ?? id);
  // The focus goes back to Change when the recorder or the question closes, as on the Keyboard page.
  const change = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !edit) change.current?.focus();
    was.current = !!edit;
  }, [edit]);
  const alpha = useHintAlphabet(t, settings, update);
  const show = bindings['hints.show']?.[0];
  const [hintBefore, hintAfter] = around(t, 'onboarding.keys.hintsNote', 'keys', show ? label(show) : '');
  const title = t('settings.kbd.prefixTitle');
  return (
    <div className="scard ob-rows ob-keys">
      <Row
        label={t('settings.kbd.prefixHead')}
        desc={t('onboarding.keys.prefixNote')}
        reset={<Reset t={t} label={t('settings.kbd.prefixHead')} show={ID in overrides && !edit} run={reset} />}
        control={
          edit ? undefined : (
            <>
              <span className="ob-caps">
                {slots.map((b, i) => (
                  <span key={b}>
                    {i > 0 && <span className="dim"> {t('settings.kbd.or')} </span>}
                    <Caps binding={b} bindings={bindings} />
                  </span>
                ))}
              </span>
              <button type="button" className="btn" ref={change} aria-label={t('settings.kbd.change', { title })} onClick={() => setEdit('record')}>
                {t('settings.kbd.changeBtn')}
              </button>
            </>
          )
        }
        extra={
          edit === 'record' ? (
            <table className="klist">
              <tbody>
                <tr>
                  <RecordingCells
                    t={t}
                    row={{ id: ID, title, ids: [ID] }}
                    bindings={bindings}
                    current={slots[0] ?? null}
                    titleOf={titleOf}
                    expand={(b) => [b]}
                    onSave={(b, clash) => store(withBindings(overrides, bindings, { [ID]: withSlot(slots, slots.length ? 0 : 'new', b) }, clash))}
                    onCancel={() => setEdit(null)}
                    onRemove={null}
                    prefixRow
                    jump={false}
                  />
                </tr>
              </tbody>
            </table>
          ) : edit ? (
            <ResetAsk t={t} id={ID} bindings={bindings} ask={edit} titleOf={titleOf} onReplace={() => store(withDefaults(overrides, bindings, [ID], edit.clash, edit.taken))} onCancel={() => setEdit(null)} />
          ) : undefined
        }
      />
      <Row
        top
        label={t('settings.keys.hintKeys')}
        desc={
          <>
            {hintBefore}
            {show && <Chord binding={show} bindings={overrides} />}
            {hintAfter}
          </>
        }
        reset={<Reset t={t} label={t('settings.keys.hintKeys')} show={alpha.changed} run={alpha.reset} />}
        extra={<AlphabetField t={t} alpha={alpha} />}
      />
    </div>
  );
}
