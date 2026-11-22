// Needs 117: a claude.ai published-artifact link the agent printed becomes a one-line card that only opens it in the
// user's browser (the link matching is in claude-link.ts). The URL is never loaded here; it is rebuilt from the matched parts, not taken from the text.
import { useContext } from 'react';
import { Tr } from '../i18n';
import { openExternal } from '../sandbox/link';
import { claudeArtifactLinks } from './claude-link';
import './claude-link.css';

export function ClaudeLinkCards({ text }: { text: string }) {
  const t = useContext(Tr);
  return (
    <>
      {claudeArtifactLinks(text).map((url) => {
        const id = url.slice(url.lastIndexOf('/') + 1);
        return (
          <div key={url} className="acard line claude-link" data-claude-link={url} title={url}>
            <span className="ic mono">↗</span>
            <span className="at">
              {t('chat.claudeLink.title')} <span className="dim mono">{id.length > 12 ? `${id.slice(0, 8)}…` : id}</span>
            </span>
            <button type="button" className="af-chip open" onClick={() => void openExternal(url)}>
              {t('chat.claudeLink.open')}
            </button>
          </div>
        );
      })}
    </>
  );
}
