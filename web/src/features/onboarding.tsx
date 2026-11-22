// Ticket 305: Settings > Onboarding; the page lives in settings/onboarding.
import { OnboardingPage } from '../settings/onboarding/OnboardingPage';
import { registerSettingsPage } from './registry';

registerSettingsPage({
  id: 'onboarding',
  title: 'Onboarding', // the nav reads `settings.page.onboarding` (i18n/areas/firstrun.ts)
  group: 'general',
  // Ticket 608: "onboarding", "setup" or "온보딩" in the palette found nothing once the first-run window was closed.
  fields: [{ key: 'onboarding', at: '[data-setting="onboarding"] .ob-step[aria-current="step"]' }],
  render: (ctx) => <OnboardingPage {...ctx} />,
});
