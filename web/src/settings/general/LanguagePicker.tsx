// Finding 22 (amends needs 144): Language is one collapsed picker, System (the OS language) by default. Ticket 250 r3: the
// final draft's row (label and description left, the styled select right).
import { LANGUAGES, resolveLanguage, type T } from '../../i18n';
import { DEFAULTS, type Settings } from '../../settings';
import { Reset, Row, Select } from '../shell/Row';
import { PageSummary } from '../shell/PageActions';

export function LanguagePicker({ t, settings, update }: { t: T; settings: Settings; update: (patch: Partial<Settings>) => void }) {
  // Look 1117 v11-A-S3-3: the hint explains System, so it shows only while System is picked.
  const system = settings.language === 'system';
  const nameOf = (id: string) => LANGUAGES.find((l) => l.id === id)?.name ?? `${t('language.system')} (${LANGUAGES.find((l) => l.id === resolveLanguage('system', navigator.language))!.name})`;
  return (
    <>
    <PageSummary parts={[[t('summary.language'), nameOf(settings.language)]]} />
    <Row
      label={t('settings.row.language')}
      desc={system && <span id="language-note">{t('settings.row.languageDesc')}</span>}
      reset={<Reset t={t} label={t('settings.row.language')} show={settings.language !== DEFAULTS.language} run={() => update({ language: DEFAULTS.language })} />}
      control={
        <Select setting="language" label={t('field.language')} describedBy={system ? 'language-note' : undefined} value={settings.language} onChange={(v) => update({ language: v as Settings['language'] })}>
          {LANGUAGES.map(({ id }) => (
            <option key={id} value={id} lang={id === 'system' ? undefined : id}>
              {nameOf(id)}
            </option>
          ))}
        </Select>
      }
    />
    </>
  );
}
