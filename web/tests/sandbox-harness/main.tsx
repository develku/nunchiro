// Test page for the artifact frame: the spec mounts it with `window.__mount(props)` and reads what it did
// from `window.__opened` (links the window would have sent to the browser) and `window.__fixture`.
import { createRoot } from 'react-dom/client';
import { ArtifactFrame, type ArtifactFrameProps } from '../../src/sandbox/ArtifactFrame';
import { Hints } from '../../src/Hints';
import '../../src/styles.css';
import '../../src/chat/chat.css'; // v1b-06
import '../../src/artifacts/artifacts.css'; // v1b-06

declare global {
  interface Window {
    __mount: (p: Partial<ArtifactFrameProps> & { artifact: ArtifactFrameProps['artifact']; origin: string; hints?: boolean; inChat?: boolean }) => void;
    __grant: (id: string, hash: string) => Promise<void>;
    __opened: string[];
    __messages: unknown[];
  }
}
window.__opened = [];
window.__messages = [];
window.addEventListener('message', (e) => window.__messages.push(e.data));
const root = createRoot(document.getElementById('root')!);
window.__mount = (all) => {
  const { origin, hints, inChat, ...p } = all;
  const frame = (
    <ArtifactFrame
      {...p}
      srcFor={(id) => `${origin}/${id}`}
      grant={(id, hash) => window.__grant(id, hash)}
      openLink={(u) => window.__opened.push(u)}
    />
  );
  root.render(
    <div style={{ width: 600 }}>
      {/* v1b-06: the same frame as a chat card, inside a chat row */}
      {inChat ? (
        <div className="chat" style={{ height: 500 }}>
          <div className="cscroll">
            <div className="clist" role="feed" style={{ height: 400 }}>
              <div className="crow" role="article">
                <div className="cin">
                  <div className="acard frame" data-state="ready">
                    {frame}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        frame
      )}
      {hints && <Hints onStart={() => {}} onDone={() => window.__mount({ ...all, hints: false })} onPath={() => {}} />}
    </div>,
  );
};
