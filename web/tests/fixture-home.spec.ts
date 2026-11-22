// The test core home must keep core.sock within the 103-byte unix socket limit (V2.5-41). Pure: no core is started.
import { expect, test } from '@playwright/test';
import { checkSocketPath, homePath } from './fixtures';

const LONG_REPO = `/${"x".repeat(68)}`; // 69 bytes, as long as the longest merge checkout seen (a 27-character lane name)

test('fixture_home_socket_fits', () => {
  expect(Buffer.byteLength(LONG_REPO)).toBe(69);
  for (const pid of [99999, 9999999]) {
    const sock = checkSocketPath(homePath(LONG_REPO, pid, '11-123'));
    expect(Buffer.byteLength(sock), `pid ${pid}: ${sock}`).toBeLessThanOrEqual(103);
  }
});

test('fixture_home_overlong_throws', () => {
  const home = homePath(`${LONG_REPO}/${'x'.repeat(40)}`, 4242, '0-0');
  const len = Buffer.byteLength(`${home}/core.sock`);
  expect(() => checkSocketPath(home)).toThrow(new RegExp(`is ${len} bytes`));
});
