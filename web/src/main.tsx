import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App';
import { CoreClient, waitForBoot } from './api';
import { CrashGuard, CrashScreen, testCrash } from './CrashScreen';
import { BrowserApp } from './pairing/BrowserApp';
import { Pairing } from './pairing/Pairing';
import { isBrowserRole, storedToken } from './pairing/boot';
import { syncBreathing } from './stateDot';
import './tokens.css';
import './book-tokens.css'; // the design book's roles over tokens.css (docs/design/design-book)
import './light-glass.css';
import './styles.css';
import './widget-quiet.css'; // ticket 1041 lane 7b: quiet buttons and fields inside the widgets

syncBreathing();
let root: Root | undefined;
// S3: every root draw sits in CrashGuard, so a throw while drawing shows the crash screen, not a white window.
const draw = (node: ReactNode) => (root ??= createRoot(document.getElementById('root')!)).render(<CrashGuard>{node}</CrashGuard>);

// V2.5-15: served by the core's browser listener, the page is the browser role: watch and answer, or pair first.
const first: Promise<ReactNode> = isBrowserRole()
  ? Promise.resolve().then(() => {
      const token = storedToken();
      return token ? <BrowserApp core={new CoreClient({ port: Number(location.port), token, browser: true })} /> : <Pairing />;
    })
  : waitForBoot().then((boot) => {
      testCrash('boot');
      return <App core={new CoreClient(boot)} boot={boot} />;
    });
// A throw before the first draw (the boot hand-off, a client that cannot be made) gets the same screen.
void first.then(draw).catch((error: unknown) => {
  console.error(error);
  draw(<CrashScreen error={error} />);
});
