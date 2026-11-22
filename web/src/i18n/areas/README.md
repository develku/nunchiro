# Area catalogues

One file per area: `areas/<area>.ts`, picked up by `import.meta.glob` in `../index.ts` (no edit there).

```ts
declare module '../index' { interface AreaKeys { 'foo.title': true } } // makes t('foo.title') type-check
export const en = { 'foo.title': 'Foo' };
export const ko = { 'foo.title': '푸' }; // optional; a missing language shows English
```

A key already in another area file fails `tests/i18n-areas.spec.ts`, naming both files.
A translation key must also be in the same file's `en`.
