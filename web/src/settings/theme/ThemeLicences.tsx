// Theme credits (V1A-34 round 3, V1A-62): each theme's licence, its author's copyright notice and source travel with
// the copy, so the app shows them here, off the cards: the catalog themes, then each installed theme that carries a
// licence, then the full NOTICES text. All text comes from generated or validated data and renders as text only.
import type { Key } from '../../i18n';
import type { ThemePick } from '../../themes/nunchiro';

/** The MIT terms for imported themes under MIT (each one's copyright line is listed with it above). */
const MIT = `MIT License (for the imported themes above marked MIT; their copyright lines are listed with them)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

type T = (key: Key, args?: Record<string, string | number>) => string;

export type Licences = Record<string, { licence: string; source: string; copyright: string[] }>;

export function ThemeLicences({ t, licences, imported, notices }: { t: T; licences: Licences; imported: ThemePick[]; notices: string }) {
  const rows = [
    ...Object.entries(licences),
    ...imported.filter((p) => p.licence || p.source).map((p) => [p.name, { licence: p.licence ?? t('settings.theme.notStated'), source: p.source ?? '', copyright: p.copyright ?? [] }] as const),
  ];
  return (
    <div className="tlic" role="region" aria-label={t('settings.theme.credits')}>
      <p className="cap">
        {t('settings.theme.creditsNote')}
      </p>
      <ul>
        {rows.map(([name, l], i) => (
          <li key={i}>
            <b>{name}</b> · {l.licence}
            {l.copyright.map((c) => (
              <span key={c} className="tcopy">
                {c}
              </span>
            ))}
            {l.source && <span className="tsrc">{l.source}</span>}
          </li>
        ))}
      </ul>
      {/* V1A-47 (carried from V1A-34): the full licence and NOTICE texts travel with the app. */}
      <details className="tlic">
        <summary>{t('settings.theme.fullTexts')}</summary>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-10)' }}>{notices}</pre>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-10)' }}>{MIT}</pre>
      </details>
    </div>
  );
}
