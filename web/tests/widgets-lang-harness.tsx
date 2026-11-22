// Ticket 513: mounts the widget gallery and placed user widgets with a fake core, under `<html lang>` from `?lang=`, so
// a page test can read each widget line in one language. Test-only (the surfaces import CSS the spec runner cannot parse).
import { createRoot } from 'react-dom/client';
import type { ApprovalCore } from '../src/approval/types';
import { UserWidgets } from '../src/widgets/Gallery';
import { UserWidget } from '../src/widgets/UserWidget';
import type { Listed, WidgetList } from '../src/widgets/api';

document.documentElement.lang = new URLSearchParams(location.search).get('lang') ?? 'en';

const w = (name: string, kind: string | null, state: Listed['state'], more: Partial<Listed> = {}): Listed => ({ name, kind, state, author: 'kai', interval_secs: 5, error: null, ...more });
const fake = (list: WidgetList): ApprovalCore =>
  ({
    request: async (r: { op: string }) => {
      if (r.op === 'widget_list') return { list };
      if (r.op === 'widget_run') return { run: { name: 'act', project: 'p', ran_at_ms: 1, interval_secs: 60, running: false, output: { format: 'json', text: '[{"a":1}]' }, error: null } };
      if (r.op === 'widget_act') return { session: 's', send: { id: 'x', status: 'queued', content: '' } };
      throw new Error(r.op);
    },
  }) as unknown as ApprovalCore;

// Script and web widgets both off: every gallery note, the off notes, the off placeholders.
const off = fake({
  enabled: false,
  web_enabled: false,
  unavailable: null,
  widgets: [w('ok', 'script', 'approved'), w('new', 'script', 'unapproved'), w('chg', 'script', 'changed'), w('int', 'integration', 'unapproved'), w('bad', 'script', null, { error: 'x' }), w('web', 'web', 'approved')],
});
// Script widgets on: an allowed widget with an act table (the row hint, then the sent note) and one for a new session.
const on = fake({
  enabled: true,
  web_enabled: false,
  unavailable: null,
  widgets: [w('act', 'script', 'approved', { act: { template: 't', session: 'target', start: null } }), w('act2', 'script', 'approved', { act: { template: 't', session: null, start: 'claude' } })],
});
const noop = () => {};
// Ticket 553 (`?case=unavailable`): script widgets on but the sandbox missing; the raw reason is each line's description.
const broken = fake({ enabled: true, web_enabled: false, unavailable: 'sandbox-exec: No such file or directory (os error 2)', widgets: [w('ok', 'script', 'approved')] });

createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).get('case') === 'unavailable' ? (
    <div style={{ display: 'grid', gap: 12, padding: 12, width: 640 }}>
      <UserWidgets core={broken} onGrab={noop} onPick={noop} />
      <UserWidget core={broken} name="ok" session={null} />
    </div>
  ) : (
  <div style={{ display: 'grid', gap: 12, padding: 12, width: 640 }}>
    <UserWidgets core={off} onGrab={noop} onPick={noop} />
    <UserWidget core={off} name="ok" session={null} />
    <UserWidget core={off} name="web" session={null} />
    <UserWidget core={on} name="act" session={null} />
    <UserWidget core={on} name="act2" session={null} />
  </div>
  ),
);
