// Ticket 391 (final.html scene a): a provider's one-line card head and an open card's titled block. Plain props only, so
// onboarding (part 2) can draw the same head without this page's state. The one-line-per-provider idea is Orca's
// AgentCatalogRow.tsx and the block order T3 Code's; no code is copied.
import type { MouseEvent, ReactNode } from 'react';
import { Chevron } from './providers';

/** A click on a control inside the head is that control's; anywhere else opens or closes the card. */
const OWN_CLICK = 'button, input, select, textarea, a, summary, details, label';

export function ProviderHead({ id, mark, name, sub, mid, chips, toggle, open, label, onToggle }: {
  /** `data-row`: the agent or ACP entry name. */
  id: string;
  mark: ReactNode;
  name: ReactNode;
  /** The small line under the name (version, the new-version mark). */
  sub?: ReactNode;
  /** The middle: default account, plan and counts, or an ACP command. */
  mid?: ReactNode;
  chips?: ReactNode;
  /** An optional switch (사용) right of the chips. */
  toggle?: ReactNode;
  /** With `onToggle`, the head opens the card and draws the chevron. */
  open?: boolean;
  label: string;
  onToggle?: () => void;
}) {
  const click = (e: MouseEvent) => onToggle && !(e.target as HTMLElement).closest(OWN_CLICK) && onToggle();
  return (
    <div className={`prv-row prv-hd${onToggle ? ' go' : ''}`} data-row={id} onClick={click}>
      {mark}
      <span className="prv-nm">
        <span className="prv-name" title={label}>
          {name}
        </span>
        {sub && <small className="prv-sub">{sub}</small>}
      </span>
      <span className="prv-meta">{mid}</span>
      <span className="prv-chips">{chips}</span>
      <span className="prv-sw">{toggle}</span>
      {onToggle ? <Chevron open={!!open} label={label} onClick={onToggle} /> : <span />}
    </div>
  );
}

/** One titled block of an open card: the title on the left, a small line under it, the content on the right. */
export function Block({ title, note, field, children }: { title: ReactNode; note?: ReactNode; field?: string; children: ReactNode }) {
  return (
    <div className="prv-blk" data-block={field}>
      <div className="prv-bh">
        {title}
        {note != null && note !== '' && <small>{note}</small>}
      </div>
      <div className="prv-bb">{children}</div>
    </div>
  );
}
