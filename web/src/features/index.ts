// Loads every feature file in this folder: each calls `registerSettingsPage` as it runs (the Vite build picks the files up
// by glob; the node test runner has no import.meta.glob, so it loads none).
try {
  import.meta.glob('./*.tsx', { eager: true });
  // The suite's fixture page lives under tests/ and is built in only when the suite asks (playwright.config.ts).
  if (import.meta.env.VITE_FEATURE_FIXTURES) Object.values(import.meta.glob('../../tests/feature-fixtures/*.tsx')).forEach((load) => void load());
} catch {
  /* no Vite */
}
