// Ticket 250: the absorb seams from a feature's own file: two pages in a group by `order`, a section on a built-in page
// whose field joins the search, and two window values through defineSetting / useFeatureSetting.
import { TABLES } from '../../src/i18n';
import { registerSettingsPage, registerSettingsSection } from '../../src/features/registry';
import { defineSetting, useFeatureSetting } from '../../src/settings/useFeatureSetting';

// Built into every suite's bundle; only settings-shell.spec.ts sets the flag (the other specs pin the exact nav).
if ((window as { __NUNCHIRO_SECTION_FIXTURE__?: boolean }).__NUNCHIRO_SECTION_FIXTURE__) {
  // A real section ships `field.<key>` in an area file; the fixture adds it to the live table instead.
  (TABLES.en as Record<string, string>)['field.fixtureCount'] = 'Fixture count';
  const COUNT = defineSetting('fixture.count', 3, (v) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 99 ? (v as number) : undefined));
  const NAME = defineSetting('fixture.name', 'none', (v) => (typeof v === 'string' && v.length <= 40 ? v : undefined));

  // Registered out of order on purpose: the nav sorts by `order` inside the group, after the built-in Git page.
  registerSettingsPage({ id: 'fixture-late', title: 'Fixture late', group: 'git', order: 5, render: () => <p>Late page body</p> });
  registerSettingsPage({ id: 'fixture-early', title: 'Fixture early', group: 'git', order: 2, render: () => <p>Early page body</p> });
  registerSettingsPage({ id: 'fixture-remote', title: 'Fixture remote', group: 'remote', order: 1, render: () => <p>Remote page body</p> });

  const Section = () => {
    const [count, setCount] = useFeatureSetting(COUNT);
    const [name] = useFeatureSetting(NAME);
    return (
      <section aria-labelledby="h-fixture-section">
        <h2 id="h-fixture-section">Fixture section</h2>
        <label>
          Fixture count <input type="number" data-setting="fixtureCount" value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </label>
        <p data-fixture-name>{name}</p>
      </section>
    );
  };
  registerSettingsSection({ page: 'terminal', id: 'fixture.section', order: 1, fields: [{ key: 'fixtureCount', at: '[data-setting="fixtureCount"]' }], render: () => <Section /> });
}
