// V1A-51: Ctrl+C reaches the agent while its terminal is flooded, and what it prints after paints (real core).
import { expect, openWindow, test } from './fixtures';

// Writes 100-byte lines as fast as the PTY takes them for up to 30 s, stopping at Ctrl+C: the marker shows within the
// test's 20 s only if Ctrl+C landed mid-burst. Then it stays (an exited session's terminal unmounts).
const BURST = `import signal, sys, time
hit = []
signal.signal(signal.SIGINT, lambda *_: hit.append(1))
line = ("x" * 99 + "\\n") * 1000
end = time.time() + 30
while not hit and time.time() < end:
    sys.stdout.write(line)
if hit: sys.stdout.write("\\nGOT-INT\\n"); sys.stdout.flush()
while True: signal.pause()`;

test('Ctrl+C reaches the agent during a burst, and what it prints after paints in order', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'burst', 'python3', '-I', '-B', '-c', BURST);
  await openWindow(app);
  const rows = app.locator(`.term[data-session="${a.id}"] .xterm-rows`);
  await expect(rows).toContainText('xxxxxxxxxx');
  await app.locator(`.term[data-session="${a.id}"] .xterm`).click();
  await app.keyboard.press('Control+c');
  await expect(rows).toContainText('GOT-INT', { timeout: 20_000 });
});
