// The catalogue for <html lang>, for a surface that takes no `t` prop (Search, the Agents zone, the model picker).
import { useEffect, useMemo, useState } from 'react';
import { makeT, type Lang, type T } from '../index';

/** App sets <html lang> from the language setting (useAppSettings); the returned `t` is redone when it changes. */
export function useHtmlLangT(): T {
  const [lang, setLang] = useState(() => document.documentElement.lang);
  useEffect(() => {
    const ob = new MutationObserver(() => setLang(document.documentElement.lang));
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    // Ticket 790: an effect of the same component (App's useAppSettings) can set <html lang> before this observer exists.
    setLang(document.documentElement.lang);
    return () => ob.disconnect();
  }, []);
  return useMemo(() => makeT((lang || 'en') as Lang, navigator.language), [lang]);
}
