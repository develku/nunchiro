// Ticket 372: the live-session limit band (372 mockup scenes band, armed and fail). One line under the session header
// while the core says this running session's screen shows a usage limit with a reset still ahead (`session.limit`); no
// band when no reset time could be read. It is a separate band from the ended-session problem card: the line comes from
// screen text on a running session, so it offers only Resume at <time> (the core types its fixed continue text once, at
// the reset, on the same session and account) and Switch agent (the problem card's own hand-off), never a restart or
// a start without hooks (problems.rs:1-3). Owner 11-09: resume only on this press, once, for this session.
// The Resume / Cancel toggle with its Saving state is adapted from T3 Code
// `apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx:37-103` (`RecoveryActions`, `toggle`); Snooze is left out,
// our `.btn` stands for T3's Button and the band's error line (`.err`, as the problem card) for its toast.
// MIT License, Copyright (c) 2026 T3 Tools Inc.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { useEffect, useState } from 'react';
import type { CoreClient } from '../api';
import type { T } from '../i18n';
import { ErrorDetails, explainError, plainError, rawError } from '../errors';
import type { Session } from '../types';
import { handOff } from './conversation';
import './limit.css';

/** A reset (epoch seconds) in local time: the clock alone today ("오후 2:30"), with the weekday on another day. */
export function resetTime(until: number, now = Date.now()) {
  const at = new Date(until * 1000);
  const today = at.toDateString() === new Date(now).toDateString();
  return at.toLocaleString(document.documentElement.lang || undefined, today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** Ticket 534: a refused arm as one sentence. The band's own refusals have their line; another known failure says its own
 *  plain words; anything else says the details are below. sessions.rs `limit_resume`: no limit ahead on the screen; a session
 *  (or its holder, pty.rs) that did not answer. */
function notScheduled(t: T, e: unknown): string {
  const raw = rawError(e);
  if (/did not answer/.test(raw)) return t('limit.failed.noAnswer');
  if (/^no usage limit with a reset time ahead/.test(raw)) return t('limit.failed.gone');
  return explainError(t, e).known ? plainError(t, e) : t('limit.failed');
}

export function LimitBand({ t, core, session }: { t: T; core: CoreClient; session: Session | null }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ text: string; details: string } | null>(null);
  const limit = session?.state === 'running' && !session.agent_ended ? session.limit : undefined;
  useEffect(() => setError(null), [session?.id, limit?.until]);
  if (!session || !limit) return null;
  const time = resetTime(limit.until);
  const armed = !!limit.armed;
  async function toggle() {
    setPending(true);
    setError(null);
    try {
      await core.request({ op: 'limit_resume', id: session!.id, on: !armed });
    } catch (e) {
      setError({ text: notScheduled(t, e), details: rawError(e) });
    }
    setPending(false);
  }
  return (
    <div className="problem-band limit light-limited light-edge" role="status" data-limit={armed ? 'armed' : 'reached'}>
      <b aria-hidden="true">!</b>
      <span className="cause">{armed ? t('limit.armed', { time }) : t('limit.reached', { time })}</span>
      <span className="sp" />
      <button className={armed ? 'btn' : 'btn p'} disabled={pending} onClick={() => void toggle()}>
        {pending ? t('limit.saving') : armed ? t('limit.cancel') : t('limit.resume', { time })}
      </button>
      <button className="btn" disabled={pending} onClick={() => void handOff(session.id, session.kind === 'codex' ? 'claude' : 'codex')}>
        {t('problem.switchAgent')}
      </button>
      {error && (
        <div className="err" role="alert">
          {error.text}
          <ErrorDetails t={t} details={error.details} />
        </div>
      )}
    </div>
  );
}
