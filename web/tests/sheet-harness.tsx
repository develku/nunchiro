// Mounts the permission sheet alone against a real core, as the gallery (ticket 19) will. Test-only.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CoreClient, waitForBoot } from '../src/api';
import { PermissionSheet } from '../src/approval/PermissionSheet';
import '../src/tokens.css'; // the window's roles (--bad for the home warning), as main.tsx loads them
import '../src/book-tokens.css';
import '../src/styles.css';

function Harness({ core, name }: { core: CoreClient; name: string }) {
  const [done, setDone] = useState('open');
  return (
    <>
      <p role="status">{done}</p>
      {done === 'open' && <PermissionSheet core={core} name={name} onClose={() => setDone('closed')} onGranted={(v) => setDone(`granted ${v.level}`)} />}
    </>
  );
}

void waitForBoot().then((boot) => {
  const core = new CoreClient(boot);
  const root = createRoot(document.getElementById('root')!);
  // The sheet asks the core as soon as it mounts, so mount once the socket is open.
  core.onStatus = (up) => up && root.render(<Harness core={core} name={new URLSearchParams(location.search).get('name') ?? ''} />);
  core.connect();
});
