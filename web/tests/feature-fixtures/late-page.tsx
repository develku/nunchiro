// A page that registers after the window drew, on a test's signal (ticket 170, `palette_sees_late_page`).
import { TABLES } from '../../src/i18n';
import { registerSettingsPage } from '../../src/features/registry';

// A real page ships `field.<key>` in an area file; the fixture adds it to the live table instead.
window.addEventListener('nunchiro-fixture-late', () => {
  (TABLES.en as Record<string, string>)['field.lateField'] = 'Late field';
  registerSettingsPage({
    id: 'late-fixture',
    title: 'Late fixture',
    fields: [{ key: 'lateField', at: '[data-setting="lateField"]' }],
    render: () => <input data-setting="lateField" aria-label="Late field" />,
  });
});
