// V2.5-82 (v25-space-switch-fu): two Browser panes in one window, which the shipped layout never mounts at once (one side pane,
// or the user's own Browser, never both). Pane A shows agent "alpha", pane B agent "beta"; a button closes pane B. Built in only for
// the suite and shown only to the spec that sets the flag (as fixture-page.tsx).
import { useState } from 'react';
import { BrowserSpaces } from '../../src/pane/browser/view/BrowserView';
import { registerSettingsPage } from '../../src/features/registry';
import type { T } from '../../src/i18n';
import type { Session } from '../../src/types';

const agent = (id: string, label: string) => ({ id, label, kind: 'claude', state: 'running', project: '/p', cwd: '/p' }) as unknown as Session;
const SESSIONS = [agent('sa', 'alpha'), agent('sb', 'beta')];

function Panes({ t }: { t: T }) {
  const [b, setB] = useState(true);
  return (
    <div>
      <button onClick={() => setB((x) => !x)}>{b ? 'Close pane B' : 'Open pane B'}</button>
      <div style={{ display: 'flex', gap: 8, height: 240 }}>
        <section aria-label="Pane A" style={{ flex: 1, display: 'flex' }}>
          <BrowserSpaces initial="sa" own="sa" sessions={SESSIONS} insert={() => {}} t={t} />
        </section>
        {b && (
          <section aria-label="Pane B" style={{ flex: 1, display: 'flex' }}>
            <BrowserSpaces initial="sb" own="sb" sessions={SESSIONS} insert={() => {}} t={t} />
          </section>
        )}
      </div>
    </div>
  );
}

if ((window as { __NUNCHIRO_SPACE_FIXTURE__?: boolean }).__NUNCHIRO_SPACE_FIXTURE__) registerSettingsPage({ id: 'space-switch', title: 'Space switch panes', render: (ctx) => <Panes t={ctx.t} /> });
