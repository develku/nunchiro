// The whole of a new Settings page: this one file, nothing else edited (ticket 169, `new_page_one_file`).
import { registerSettingsPage } from '../../src/features/registry';

// Built into every suite's bundle, but only the spec that sets the flag sees the page (the other specs pin the exact nav).
if ((window as { __NUNCHIRO_FEATURE_FIXTURE__?: boolean }).__NUNCHIRO_FEATURE_FIXTURE__) {
  registerSettingsPage({
    id: 'fixture',
    title: 'Fixture page',
    render: () => (
      <section>
        <h2>Fixture page</h2>
        <p>Registered from one file.</p>
      </section>
    ),
  });
}
