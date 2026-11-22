// TREEHEAD r5: a head's ref entry is dropped when the head unmounts. Pure: the ref-callback factory takes plain maps.
import { expect, test } from '@playwright/test';
import { headRefOf } from '../src/tree/headHold';

type Ref = (el: HTMLElement | null) => void;
const el = {} as HTMLElement;

test('head_hold_refs_entry_removed_on_unmount', () => {
  const refs = new Map<string, Ref>();
  const released: string[] = [];
  const f = headRefOf('p', refs, (p) => released.push(p));
  f(el);
  expect(refs.has('p')).toBe(true);
  expect(released).toEqual([]);
  f(null);
  expect(refs.has('p')).toBe(false);
  expect(released).toEqual(['p']);
  expect(headRefOf('p', refs, () => {})).not.toBe(f); // shown again: a fresh callback
});

test('head_hold_refs_replaced_callback_keeps_successor', () => {
  const refs = new Map<string, Ref>();
  const old = headRefOf('p', refs, () => {});
  refs.delete('p'); // React replaced it: a new callback now owns the entry
  const next = headRefOf('p', refs, () => {});
  old(null);
  expect(refs.get('p')).toBe(next);
});
