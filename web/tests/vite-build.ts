import { build, type InlineConfig } from 'vite';

/** Vite's `build()` sets process.env.NODE_ENV=production in the calling process when it is unset; a later spec in the
 *  same Playwright worker then mixes the dev jsx runtime with the production react-dom/server (pr-chip: "dispatcher.getOwner
 *  is not a function"). Every spec builds through this and gets the variable back. */
export async function buildQuiet(config: InlineConfig) {
  const saved = process.env.NODE_ENV;
  try {
    return await build(config);
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}
