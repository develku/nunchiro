// Ticket 1066: older done cards. A fold at the foot of the Done column, closed by default; open, it lists the cards
// (title, done date, receipt line) with a search box over title and receipt text. Nothing here deletes a card.
import { Fragment, useState, type ReactNode } from 'react';
import { PLAIN } from '../plainText';
import type { T } from './Board';
import type { Card } from './model';
import { doneAt, doneGroups } from './tasks';

/** Done cards under their day heads, newest first (1066), as list items: one implementation for every board view (ticket 1090). */
export function DoneDays({ t, cards, now, item }: { t: T; cards: Card[]; now: number; item: (card: Card) => ReactNode }) {
  return doneGroups(cards, now).map((g) => (
    <Fragment key={g.head}>
      <li className="bdh" data-day={g.head}>
        {t(`board.done.${g.head}`)}
      </li>
      {g.cards.map(item)}
    </Fragment>
  ));
}

const line = (c: Card) => (c.receipt ? `${c.receipt.sha !== '-' ? `${c.receipt.sha.slice(0, 7)} · ` : ''}${c.receipt.command} · ${c.receipt.result}` : '');

export function Archive({ t, cards }: { t: T; cards: Card[] }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = [...cards]
    .sort((a, b) => doneAt(b) - doneAt(a))
    .filter((c) => !q || [c.title, c.receipt?.sha, line(c)].some((s) => s?.toLowerCase().includes(q)));
  return (
    <details className="barch" data-archive>
      <summary>{t('board.archive', { n: cards.length })}</summary>
      <input {...PLAIN} type="search" className="barchq" value={query} aria-label={t('board.archive.search')} placeholder={t('board.archive.search')} onChange={(e) => setQuery(e.target.value)} />
      <ul className="barchl">
        {shown.map((c) => (
          <li key={c.id}>
            <span className="barcht" title={c.title}>{c.title}</span>
            <time className="dim" dateTime={new Date(doneAt(c)).toISOString()}>{new Date(doneAt(c)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
            {c.receipt && <span className="brc">{line(c)}</span>}
          </li>
        ))}
        {!shown.length && <li className="dim">{t('board.archive.none')}</li>}
      </ul>
    </details>
  );
}
