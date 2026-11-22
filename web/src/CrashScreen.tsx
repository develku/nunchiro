// S3: a throw while the window draws (or before its first draw) shows this screen with a way back, never a white window.
// Same surface as the boot failure screen (App.tsx BootStandIn). React itself logs the caught error to the console; the
// window has no request that writes to the core's log.
import { Component, useEffect, useState, type ReactNode } from 'react';
import { makeT } from './i18n';
import { KEY, parse } from './settings';
import { copyText } from './terminal/clipboard';
import './pane/browser/view/browser-view.css';

const language = () => {
  try {
    return parse(localStorage.getItem(KEY)).settings.language; // parse, not load: load may write a backup
  } catch {
    return 'system' as const; // the settings store may be what broke
  }
};

/** What "Copy details" puts on the clipboard: the message, the browser's stack and React's component stack. */
export function details(error: unknown, componentStack = '') {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // Chromium's stack starts with the message line; WebKit's does not.
  const stack = error instanceof Error ? (error.stack ?? '').replace(message, '').trim() : '';
  return [message, stack, componentStack.trim()].filter(Boolean).join('\n\n');
}

export function CrashScreen({ error, componentStack }: { error: unknown; componentStack?: string }) {
  const t = makeT(language(), navigator.language);
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const id = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <div className="bview">
      <div className="bfail" role="alert" data-state="crashed">
        <div className="bfail-title">{t('shell.crash.title')}</div>
        <div className="bfail-note">{t('shell.crash.note')}</div>
        <div className="bfail-acts">
          <button type="button" className="btn p" onClick={() => location.reload()}>
            {t('shell.crash.reload')}
          </button>
          {/* Written inside the click: WebKit drops a clipboard write once the gesture is gone. */}
          <button type="button" className="btn" onClick={() => void copyText(details(error, componentStack)).then(setCopied)}>
            {t(copied === null ? 'shell.crash.copy' : copied ? 'about.copied' : 'about.copyFailed')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The window's root boundary (main.tsx), FileView's ChunkError pattern at the top. */
export class CrashGuard extends Component<{ children: ReactNode }, { error: unknown; componentStack?: string; crashed: boolean }> {
  state = { error: null as unknown, componentStack: undefined as string | undefined, crashed: false };
  static getDerivedStateFromError(error: unknown) {
    return { error, crashed: true };
  }
  componentDidCatch(_: unknown, info: { componentStack?: string | null }) {
    this.setState({ componentStack: info.componentStack ?? undefined });
  }
  render() {
    if (this.state.crashed) return <CrashScreen error={this.state.error} componentStack={this.state.componentStack} />;
    return (
      <>
        {import.meta.env.VITE_FEATURE_FIXTURES && <TestCrash />}
        {this.props.children}
      </>
    );
  }
}

type CrashWhere = 'boot' | 'render';
/** Test builds only (VITE_FEATURE_FIXTURES): throws where `window.__testCrash` says. Shipped builds drop it. */
export function testCrash(where: CrashWhere) {
  if (import.meta.env.VITE_FEATURE_FIXTURES && (window as { __testCrash?: CrashWhere }).__testCrash === where) throw new Error(`test crash (${where})`);
}

/** 'render' set before load throws in the first draw; set later, it throws on the draw after `nunchiro:test-crash`. */
function TestCrash() {
  const [, redraw] = useState(0);
  useEffect(() => {
    const on = () => redraw((n) => n + 1);
    window.addEventListener('nunchiro:test-crash', on);
    return () => window.removeEventListener('nunchiro:test-crash', on);
  }, []);
  testCrash('render');
  return null;
}
