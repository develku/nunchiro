// Bot memory, layer 3 (approved mockup, frame 4 "Search hit"): a seat's `memory_search` call shows in its reply as one
// line with the hit count, the newest hit as a card that opens its conversation, and the other hits in one line. The
// tool's result is the core's `memory_hits` reply (`nunchiro memory search --json`); anything else shows as a tool row.
import { useContext } from 'react';
import { Tr } from '../i18n';
import { Icon } from '../icons/Icon';
import { openSession } from '../tree';
import { outputText, type Tool } from './model';
import './memory-hits.css';

type Hit = { session: string; label: string; kind: string; at: string; role: string; text: string };
type Hits = { hits: Hit[]; total: number };

export function memoryHits(tool: Tool): Hits | null {
  if (!tool.result || tool.result.is_error) return null;
  try {
    const r = JSON.parse(outputText(tool.result.output));
    return r?.type === 'memory_hits' && Array.isArray(r.hits) && typeof r.total === 'number' ? r : null;
  } catch {
    return null;
  }
}

const agent = (kind: string) => (kind === 'claude' ? 'Claude Code' : kind === 'codex' ? 'Codex' : kind === 'acp' ? 'ACP' : kind);
const pad = (n: number) => String(n).padStart(2, '0');
/** "11-12", and "11-12 · 14:05" with the time, in this Mac's zone; the agent's own text when it is no date. */
function when(at: string, time: boolean) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const day = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return time ? `${day} · ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

export function MemoryHits({ tool }: { tool: Tool }) {
  const t = useContext(Tr);
  const found = memoryHits(tool);
  if (!found) return null;
  const [first, ...rest] = found.hits;
  const more = found.total - 1;
  return (
    <div className="mem-hits" data-memory-hits>
      <div className="mem-hits-head">
        <Icon name="search" size={12} />
        {t(found.total === 1 ? 'memory.hits.one' : 'memory.hits', { n: found.total })}
      </div>
      {first && (
        <div className="mem-hit" data-memory-hit={first.session}>
          <Icon name="history" size={16} />
          <div className="mem-hit-body">
            <b className="wordcut">{first.label || agent(first.kind)}</b>
            <span className="wordcut">
              {agent(first.kind)} · {when(first.at, true)} · “{first.text}”
            </span>
          </div>
          <button type="button" className="btn" onClick={() => openSession(first.session)}>
            {t('memory.hits.open')}
          </button>
        </div>
      )}
      {more > 0 && (
        <div className="mem-hits-more">
          {t(more === 1 ? 'memory.hits.more.one' : 'memory.hits.more', { n: more })}
          {rest.length > 0 && ` · ${rest.slice(0, 3).map((h) => `${agent(h.kind)} ${when(h.at, false)}`).join(', ')}`}
        </div>
      )}
    </div>
  );
}
