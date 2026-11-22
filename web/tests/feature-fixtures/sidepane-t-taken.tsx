// V2.5-82 (v25-sidepane-t): a second Browser switcher on "My browser", hidden, so the agent pane's switcher lists that space as
// taken (the shipped layout never mounts both at once). Built in only for the suite and mounted only for the spec that sets the flag.
import { createRoot } from 'react-dom/client';
import { BrowserSpaces } from '../../src/pane/browser/view/BrowserView';

if ((window as { __NUNCHIRO_SIDEPANE_TAKEN__?: boolean }).__NUNCHIRO_SIDEPANE_TAKEN__) {
  const host = document.createElement('div');
  host.hidden = true;
  document.body.append(host);
  createRoot(host).render(<BrowserSpaces initial="you" sessions={[]} insert={() => {}} />);
}
