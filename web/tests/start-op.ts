// The start a window request carries. Since #57 the window's own starts (the New tab menu, the tree's +, Add project) go
// as `start_or_wait`, and Start anyway as `start_anyway`, each with the `start` inside. A spec that mocks, holds or counts
// starts reads them through `startOf`, so a start sent wrapped is still seen (three specs missed it: #109, #138, then the
// sweep that added this helper). The object returned is the inner start itself, so a mock may change it in place.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = Record<string, any>;
export function startOf(r: Req | null | undefined): Req | null {
  if (!r) return null;
  if (r.op === 'start') return r;
  if ((r.op === 'start_or_wait' || r.op === 'start_anyway') && r.start?.op === 'start') return r.start as Req;
  return null;
}
