// Screenshots of the Files sidebar and one tab per kind (not assertions; no R8 frame exists for Files), and the
// JS heap with one highlighted file open. Run with SHOTS=1.
import fs from 'node:fs';
import path from 'node:path';
import { expect, REPO, test } from './fixtures';
import { openFile, setup, view } from './fixtures/files/harness';

const OUT = path.join(REPO, '.scratch/shots');

test('files screens', async ({ app, core }, info) => {
  test.skip(info.project.name !== 'chromium' || !process.env.SHOTS, 'run with SHOTS=1');
  fs.mkdirSync(OUT, { recursive: true });
  await setup(app, core, {
    extra: (d) => {
      fs.mkdirSync(path.join(d, 'src'));
      fs.writeFileSync(path.join(d, 'src/main.rs'), 'fn main() {\n    println!("hi");\n}\n');
      fs.writeFileSync(path.join(d, 'big.log'), 'x'.repeat(5 * 1024 * 1024));
    },
  });
  const cdp = await app.context().newCDPSession(app);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    return metrics.find((m) => m.name === 'JSHeapUsedSize')!.value / 1024 / 1024;
  };
  await cdp.send('Performance.enable');
  const before = await heap();
  await app.locator('.frow[data-path="src"]').click();
  await app.screenshot({ path: path.join(OUT, 'files-0-tree.png') });
  const shots: [string, string][] = [
    ['hello.ts', 'files-1-text.png'],
    ['README.md', 'files-2-markdown.png'],
    ['dot.png', 'files-3-png.png'],
    ['logo.svg', 'files-4-svg.png'],
    ['page.html', 'files-5-html.png'],
    ['blob.bin', 'files-6-binary.png'],
    ['big.log', 'files-7-large.png'],
  ];
  for (const [file, shot] of shots) {
    await openFile(app, file);
    if (file === 'hello.ts') {
      await expect(view(app, file).locator('.sh').first()).toBeVisible();
      console.log(`JS heap: ${before.toFixed(1)} MB before, ${(await heap()).toFixed(1)} MB with hello.ts highlighted`);
    }
    await app.waitForTimeout(300);
    await app.screenshot({ path: path.join(OUT, shot) });
  }
  await openFile(app, 'hello.ts');
  await app.emulateMedia({ colorScheme: 'dark' });
  await app.screenshot({ path: path.join(OUT, 'files-8-text-dark.png') });
});
