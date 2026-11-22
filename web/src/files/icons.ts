// File tree icons (V1A-63): one table from names to sprite symbols (sprite.ts) and one lookup. Plain data, so a later
// icon-theme option can swap the table without touching the tree.
import { SYMBOLS } from './sprite';

/** Whole file names, lower-cased; these beat the extension. */
export const NAMES: Record<string, string> = {
  'cargo.toml': 'rust',
  'cargo.lock': 'lock',
  'package.json': 'npm',
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'lock',
  'yarn.lock': 'lock',
  dockerfile: 'docker',
  '.dockerignore': 'docker',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  'readme.md': 'readme',
  readme: 'readme',
  license: 'license',
  'license.md': 'license',
  'license.txt': 'license',
  licence: 'license',
  copying: 'license',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.editorconfig': 'settings',
  '.env': 'settings',
};

/** Extensions (after the last dot), lower-cased. */
export const EXTENSIONS: Record<string, string> = {
  rs: 'rust',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'react', jsx: 'react',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  py: 'python',
  go: 'go',
  html: 'html', htm: 'html',
  css: 'css',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  yml: 'yaml', yaml: 'yaml',
  vue: 'vue',
  swift: 'swift',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  rb: 'ruby',
  lua: 'lua',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  svg: 'svg',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', bmp: 'image', avif: 'image',
  pdf: 'pdf',
  csv: 'csv', tsv: 'csv',
  xml: 'xml', plist: 'xml',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video',
  sql: 'db', sqlite: 'db', db: 'db',
  lock: 'lock',
  toml: 'settings', ini: 'settings', conf: 'settings', cfg: 'settings',
  zip: 'zip', tar: 'zip', gz: 'zip', tgz: 'zip', bz2: 'zip', xz: 'zip', '7z': 'zip', rar: 'zip',
};

/** The sprite symbol (without the `fi-` prefix) for a tree entry. */
export function iconFor(name: string, kind: string, open = false): string {
  if (kind === 'dir') return open ? 'folder-open' : 'folder';
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  // A leading dot alone (".prettierrc") is part of the name, not an extension.
  // Own keys only: a file named "constructor" must not find Object.prototype's.
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  if (Object.hasOwn(NAMES, lower)) return NAMES[lower];
  return Object.hasOwn(EXTENSIONS, ext) ? EXTENSIONS[ext] : 'file';
}

/** Puts the sprite in the document once; rows draw `<use href="#fi-...">`. */
export function ensureSprite() {
  if (document.getElementById('file-icons')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'file-icons';
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = SYMBOLS;
  document.body.append(svg);
}
