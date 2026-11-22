// V2-37 (27c SHOULDs): the app's Allow never sends an empty requester, and Settings keeps only entries whose sha512
// and size are well formed. Node-side: the module under test with the core client stood in; no page, no network.
import { expect, test } from '@playwright/test';
import { CoreClient } from '../src/api';
import { NO_REQUESTER, appLibs, cleanList } from '../src/sandbox/libs';

const URL1 = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';

test('allow_without_requester_sends_fallback: undefined or empty becomes the fixed fallback, a name is kept', async () => {
  const ops: unknown[] = [];
  CoreClient.main = { libs: async (op: unknown) => void ops.push(op) } as unknown as CoreClient;
  try {
    await appLibs.allow(URL1, null, undefined as unknown as string);
    await appLibs.allow(URL1, 'sha384-x', '');
    await appLibs.allow(URL1, null, 'sales-bot');
  } finally {
    CoreClient.main = null;
  }
  expect(NO_REQUESTER).toBe('a page not opened from a session');
  expect(ops).toEqual([
    { op: 'libs_allow', url: URL1, requester: NO_REQUESTER },
    { op: 'libs_allow', url: URL1, requester: NO_REQUESTER, integrity: 'sha384-x' },
    { op: 'libs_allow', url: URL1, requester: 'sales-bot' },
  ]);
});

test('clean_list_rejects_bad_sha512_and_size: only well-formed entries reach Settings', () => {
  const good = {
    host: 'cdnjs.cloudflare.com',
    path: '/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
    library: 'Chart.js',
    version: '4.4.1',
    file: 'chart.umd.min.js',
    sha384: 'a'.repeat(96),
    sha512: 'b'.repeat(128),
    size: 100,
    fetched_at: 1,
    badge: 'verified',
    first_requester: 's',
  };
  const bad = [
    { sha512: 'B'.repeat(128) },
    { sha512: 'b'.repeat(127) },
    { sha512: 'g'.repeat(128) },
    { sha512: 42 },
    { sha512: undefined },
    { size: 0 },
    { size: -1 },
    { size: 1.5 },
    { size: 8 * 1024 * 1024 + 1 },
    { size: '100' },
    { size: Number.NaN },
    { size: undefined },
  ].map((o) => ({ ...good, ...o }));
  const edge = { ...good, size: 8 * 1024 * 1024 };
  expect(cleanList({ entries: [good, ...bad, edge], auto_allow: [], saved: true }).entries).toEqual([good, edge]);
});

// Ticket 366: the core's default switches reach Settings only well-formed; an older core without them lists none.
test('clean_list_keeps_well_formed_defaults_366', () => {
  const d3 = { host: 'cdnjs.cloudflare.com', library: 'd3' };
  expect(cleanList({ entries: [], auto_allow: [], defaults: [d3, { host: 1, library: 'x' }, null, { host: 'h' }], saved: true }).defaults).toEqual([d3]);
  expect(cleanList({ entries: [], auto_allow: [], saved: true }).defaults).toEqual([]);
  expect(cleanList({ entries: [], auto_allow: [], defaults: 'd3', saved: true }).defaults).toEqual([]);
});
