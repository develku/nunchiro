// The V1A-44 measure page (xterm with the window's options, DOM or WebGL renderer); built into .scratch, never dist/.
import { defineConfig } from 'vite';
import path from 'node:path';

const port = Number(process.env.PAINT_PAGE_PORT ?? 4184);

export default defineConfig({
  root: path.join(import.meta.dirname, 'page'),
  build: { outDir: path.resolve(import.meta.dirname, '../../.scratch/measure-page'), emptyOutDir: true, target: 'safari16' },
  preview: { host: '127.0.0.1', port, strictPort: true },
});
