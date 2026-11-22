// Ticket 250 r3: the one row kit every Settings page draws with. Lifted from the approved final draft's builders
// (docs/design/settings-1103/final.html `sec`, `row`, `tog`, `seg`, `sel`, `step`, `radios`): a section is a small title
// above a card; a row is the label and description on the left and the control on the right. The controls stay native
// (a checkbox with role switch, radio inputs, a select, a number field) so keyboard, focus and the settings search work
// as before; CSS in shell.css gives them the draft's look.
import { PLAIN } from '../../plainText';
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../../icons/Icon';
import { StrokeIcon } from './NavIcon';
import { basename } from '../../tree';
import { push as pushUndo } from '../../undo/store';
import type { Key } from '../../i18n';

type T = (key: Key, args?: Record<string, string | number>) => string;

/** A titled card. `id` names the title for the section's label; a section without a title is labelled by `label`. */
export function Sec({ id, title, lede, right, action, label, className, children }: { id?: string; title?: ReactNode; lede?: ReactNode; right?: ReactNode; action?: ReactNode; label?: string; className?: string; children: ReactNode }) {
  return (
    <section className={`ssec${className ? ` ${className}` : ''}`} {...(title && id ? { 'aria-labelledby': id } : label ? { 'aria-label': label } : {})}>
      {title && (
        <h2 id={id}>
          {title}
          {right && <span className="sr-right">{right}</span>}
        </h2>
      )}
      {action && <div className="sec-act">{action}</div>}
      {lede && <p className="lede">{lede}</p>}
      <div className="scard">{children}</div>
    </section>
  );
}

/** One setting: label and description left, control right. `top` aligns the control with the label's first line;
 *  `sub` indents a row that belongs to the one above; `extra` sits under the description (radio cards, a list);
 *  `icon` sits left of the label, `chip` (a status) and `reset` (a <Reset>) after it, outside the name `id` gives. */
export function Row({ label, desc, control, id, top, sub, extra, className, setting, icon, chip, reset, why }: { label: ReactNode; desc?: ReactNode; control?: ReactNode; id?: string; top?: boolean; sub?: boolean; extra?: ReactNode; className?: string; setting?: string; icon?: ReactNode; chip?: ReactNode; reset?: ReactNode; why?: ReactNode }) {
  const text = (
    <>
      <div className="snm">
        {/* Look 1117 v13/v14 N2: the name works like a <label> for the row's switch, so a click or an accessibility press on
            the name text (what VoiceOver and the look driver reach first) flips it; a link or button inside the name keeps its own. */}
        <span id={id} onClick={(e) => !(e.target as Element).closest('a, button') && e.currentTarget.closest('.srow')?.querySelector<HTMLInputElement>(':scope > .sctl input[role="switch"]')?.click()}>
          {label}
        </span>
        {chip}
        {reset}
      </div>
      {desc && <div className="sds">{desc}</div>}
      {why}
      {extra}
    </>
  );
  return (
    <div className={`srow${top ? ' top' : ''}${sub ? ' sub' : ''}${className ? ` ${className}` : ''}`} data-row={setting}>
      {icon ? (
        <div className="slab wi">
          {icon}
          <div>{text}</div>
        </div>
      ) : (
        <div className="slab">{text}</div>
      )}
      {control !== undefined && <div className="sctl">{control}</div>}
    </div>
  );
}

/** Ticket 475 (453 pick B): why a control cannot work right now, and the fix, as one line on its row (Row `why`), never a
 *  tooltip. The disabled control names `id` in aria-describedby, so a screen reader and settings-why.spec.ts find the
 *  reason from the control. `fix` is a WhyFix that goes to the place that fixes it; without one the reason says what to do. */
export function Why({ id, reason, fix }: { id: string; reason: ReactNode; fix?: ReactNode }) {
  return (
    <span className="swhy" id={id} data-why={id}>
      <span>{reason}</span>
      {fix}
    </span>
  );
}

/** The fix in a Why line: a link-styled button that says where it goes. */
export function WhyFix({ label, run }: { label: string; run: () => void }) {
  return (
    <button type="button" className="swhy-fix" onClick={run}>
      {label}
    </button>
  );
}

// shortcut: the web has no home folder value, so any /Users/<x> or /home/<x> reads as ~ (a folder directly under the users root, such as the shared one, too); use the core's home when the web gets one.
/** A path as shown: the home folder written as ~. */
export const tilde = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

/** Ticket 518: where a row's value comes from when it is not set in the scope in view. `paths`: the projects that set it. */
export type Source = { from: 'default' } | { from: 'all' } | { from: 'project'; paths: string[] };

/** Ticket 518 (VS Code's "Modified in: Workspace", idea only): the muted tag for a Source; null (set right here) draws
 *  nothing, as the Reset mark already says "changed". Plain text, not a button; the title names the full place. */
export function SourceTag({ t, source }: { t: T; source: Source | null }) {
  if (!source) return null;
  const [word, tip] =
    source.from === 'default'
      ? [t('settings.source.default'), t('settings.source.defaultTip')]
      : source.from === 'all'
        ? [t('shell.scope.all'), t('settings.source.allTip')]
        : [
            source.paths.length === 1 ? t('settings.source.changedIn', { name: basename(source.paths[0]) }) : t('settings.source.changedInCount.other', { n: source.paths.length }),
            t('settings.source.projectTip', { where: source.paths.map(tilde).join(', ') }),
          ];
  return (
    <span className="ssrc" data-source={source.from} title={tip}>
      {word}
    </span>
  );
}

/** Ticket 311 (T3 Code's SettingResetButton, settingsLayout.tsx:520, MIT License, Copyright (c) 2026 T3 Tools Inc.; idea only):
 *  puts one row back; drawn only while `show` says the row differs from its default. Focus moves to the row's control, as
 *  this button is gone after the click. */
export function Reset({ t, label, show, run }: { t: T; label: string; show: boolean; run: () => void }) {
  if (!show) return null;
  return (
    <button
      type="button"
      className="sreset"
      aria-label={t('settings.kit.resetRow', { label })}
      title={t('settings.kit.resetTip')}
      onClick={(e) => {
        // A Providers card line (`.prv-ln`, accounts/providers.tsx `Ln`) is a row too: its control sits in `.prv-v`.
        const row = e.currentTarget.closest('.srow, .prv-ln');
        run();
        row?.querySelector<HTMLElement>(':is(.sctl, .prv-v) :is(input, select, button:not([tabindex="-1"]))')?.focus();
      }}
    >
      <StrokeIcon name="undo" size={12} />
    </button>
  );
}

/** Ticket 311: a card's "Reset to defaults" (Sec `action`), one undo away; drawn only while something in the card differs. */
export function SecReset({ t, section, show, run, undo }: { t: T; section: string; show: boolean; run: () => void; undo: () => void }) {
  if (!show) return null;
  return (
    <button
      type="button"
      className="btn"
      aria-label={t('settings.kit.resetSec', { section })}
      onClick={() => {
        run();
        pushUndo({ label: t('settings.kit.resetDone', { section }), undo });
      }}
    >
      {t('settings.kit.toDefaults')}
    </button>
  );
}

/** A boolean as a switch: a native checkbox (Space toggles it, the search focuses it) with role switch. */
export function Switch({ checked, onChange, label, setting, disabled, describedBy }: { checked: boolean; onChange: (v: boolean) => void; label: string; setting?: string; disabled?: boolean; describedBy?: string }) {
  // Ticket 475: a switch that says why it cannot work stays focusable (aria-disabled), so Tab and the palette's jump to
  // the setting still reach it and read the reason; a native disabled one would be skipped.
  const said = disabled && !!describedBy;
  return <input type="checkbox" role="switch" className="stog" aria-label={label} aria-describedby={describedBy} aria-disabled={said || undefined} data-setting={setting} checked={checked} disabled={disabled && !said} onChange={(e) => !said && onChange(e.target.checked)} />;
}

/** Two to four choices in one line (final.html `seg`): native radios, so arrow keys move the choice. */
export function Seg<V extends string>({ name, value, options, onChange, label, setting }: { name: string; value: V | null; options: [V, ReactNode][]; onChange: (v: V) => void; label: string; setting?: string }) {
  return (
    <div className="sseg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <label key={v}>
          <input type="radio" name={name} value={v} data-setting={setting} checked={value === v} onChange={() => onChange(v)} />
          <span>{text}</span>
        </label>
      ))}
    </div>
  );
}

/** Choices with a sentence each, as cards (final.html `radios`); `cols` lays them side by side. */
export function RadioCards<V extends string>({ name, value, options, onChange, labelledBy, cols, setting, ariaLabels }: { name: string; value: V; options: [V, string, string][]; onChange: (v: V) => void; labelledBy?: string; cols?: boolean; setting?: string; ariaLabels?: Partial<Record<V, string>> }) {
  return (
    <div className={`sradios${cols ? ' cols' : ''}`} role="radiogroup" aria-labelledby={labelledBy}>
      {options.map(([v, title, cap]) => (
        <label key={v} className={`src${value === v ? ' on' : ''}`}>
          <input type="radio" name={name} value={v} data-setting={setting} aria-label={ariaLabels?.[v]} checked={value === v} onChange={() => onChange(v)} />
          <span>
            <b>{title}</b>
            <small>{cap}</small>
          </span>
        </label>
      ))}
    </div>
  );
}

/** A native select drawn as the draft's (final.html `sel`): the system menu, the draft's box and chevron. */
export function Select({ value, onChange, label, setting, describedBy, disabled, autoFocus, children }: { value: string; onChange: (v: string) => void; label: string; setting?: string; describedBy?: string; disabled?: boolean; autoFocus?: boolean; children: ReactNode }) {
  return (
    <span className="ssel">
      <select aria-label={label} aria-describedby={describedBy} data-setting={setting} value={value} disabled={disabled} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
      <Icon name="chevron-down" size={12} />
    </span>
  );
}

/** A typed number with − and + (final.html `step`); a value out of range or off the step is held, not applied. */
/** `inc` is what − and + move by when typing allows finer values (`step`). */
export function Stepper({ t, label, min, max, step, inc = step, value, unit = 'px', onChange, setting }: { t: T; label: string; min: number; max: number; step: number; inc?: number; value: number; unit?: string; onChange: (v: number) => void; setting?: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const fits = (n: number) => Number.isFinite(n) && n >= min && n <= max && Number.isInteger(Math.round(((n - min) / step) * 1e6) / 1e6);
  const ok = draft.trim() !== '' && fits(Number(draft));
  const by = (k: number) => onChange(Math.min(max, Math.max(min, Math.round((value + k * inc) * 1e6) / 1e6)));
  return (
    <StepBox t={t} label={label} unit={unit} down={value > min ? () => by(-1) : null} up={value < max ? () => by(1) : null}>
      <input {...PLAIN}
        type="number"
        aria-label={label}
        data-setting={setting}
        min={min}
        max={max}
        step={step}
        value={draft}
        // The value in use, with its unit (the unit beside the field is hidden from assistive technology).
        aria-valuenow={value}
        aria-valuetext={unit ? `${value} ${unit}` : String(value)}
        aria-invalid={!ok}
        title={`${min}–${max}${unit ? ` ${unit}` : ''}`} // the allowed range, for a red (held) value
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && fits(n) && n !== value) onChange(n);
        }}
        onBlur={() => setDraft(String(value))}
      />
    </StepBox>
  );
}

/** The stepper's frame (− field unit +) around a field that keeps its own rules: Stepper's, or a page's number that
 *  applies only when left (Scrollback, Browser Access port; look 1117 v15 Q6-11). A null `down` or `up` greys its button. */
export function StepBox({ t, label, unit, down, up, children }: { t: T; label: string; unit?: string; down: (() => void) | null; up: (() => void) | null; children: ReactNode }) {
  return (
    <span className="sstep field-box">
      <button type="button" tabIndex={-1} aria-label={t('settings.step.down', { label })} disabled={!down} onClick={() => down?.()}>
        −
      </button>
      {children}
      {unit && (
        <span className="unit" aria-hidden>
          {unit}
        </span>
      )}
      <button type="button" tabIndex={-1} aria-label={t('settings.step.up', { label })} disabled={!up} onClick={() => up?.()}>
        +
      </button>
    </span>
  );
}
