// v1b-05: composer image chips (thumbnail, name, ✕) in this window's chip style (R8 `.chip`).
// Adapted from MonoCode `src/features/sessions/ui/AttachmentChip.tsx`, commit 26465c6 (remove button labelled
// with the name, thumbnail decoded once outside rerenders). MIT License, Copyright (c) 2026 Nick.
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
import { useEffect, useRef, useState } from 'react';
import { b64, type Chip } from './attach';
import { Thumbnail, type Source } from './Thumbnail';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import './images.css';

/** needs 172: the chip's picture and name open the same viewer the message thumbnails use (Thumbnail owns the click, the keys and the focus return). */
function Preview({ chip, label }: { chip: Chip; label: string }) {
  const [source, setSource] = useState<Source | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let live = true;
    void chip.blob.arrayBuffer().then((buf) => live && setSource({ type: 'base64', media_type: chip.blob.type, data: b64(new Uint8Array(buf)), path: chip.name })); // `path` only names it: a base64 source is never read from disk
    return () => {
      live = false;
    };
  }, [chip.blob, chip.name]);
  return (
    <>
      <span className="ipic" ref={root}>
        {source ? <Thumbnail source={source} /> : <img src={chip.thumb} alt="" />}
      </span>
      <span className="iname" onClick={() => root.current?.querySelector<HTMLElement>('[data-slot="thumbnail"]')?.click()}>
        {label}
      </span>
    </>
  );
}

export function ImageChips({ chips, error, onRemove }: { chips: Chip[]; error: string; onRemove: (id: string) => void }) {
  const t = useHtmlLangT(); // ticket 508
  if (!chips.length && !error) return null;
  return (
    <div className="ichips">
      {chips.map((c, i) => {
        const label = /^image\.\w+$/.test(c.name) ? t('composer.imageN', { n: i + 1 }) : c.name; // ticket 1044: clipboard images are all "image.png"
        return (
        <span key={c.id} className="chip ichip" data-saving={c.saving ? '' : undefined} title={label}>
          <Preview chip={c} label={label} />
          {c.saving && <span className="sr">{t('rest.widgets.chips.saving')}</span>}
          <button type="button" className="ix" aria-label={t('rest.widgets.chips.remove', { name: label })} onClick={() => onRemove(c.id)}>
            ✕
          </button>
        </span>
        );
      })}
      {error && (
        <span className="ierr" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
