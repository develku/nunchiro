// D5b lane B (B03, B05, B06): the widgets nested under one project, shown after its session rows. Rendering a widget is
// the window's job (`render`, project-scoped); this file is the header, the fold and the capped body.
import type { ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import { nestKey } from '../layout/bars';
import './subviews.css';
import { enT, type T } from './state';

export interface SubViewsCtx {
  nest: Record<string, string[]>;
  open: Record<string, boolean>;
  editing: boolean;
  title: (kind: string) => string;
  render: (project: string, kind: string) => ReactNode;
  onToggle: (project: string, kind: string) => void;
  onRemove: (project: string, kind: string) => void;
}

export function SubViews({ project, name, ctx, t = enT }: { project: string; name: string; ctx?: SubViewsCtx; t?: T }) {
  const kinds = ctx?.nest[project];
  if (!ctx || !kinds?.length) return null;
  return (
    <>
      {kinds.map((k) => {
        const on = !!ctx.open[nestKey(project, k)];
        const title = ctx.title(k);
        return (
          <div className="view" data-view={k} key={k}>
            <div className="vh">
              <button className="vt" aria-expanded={on} onClick={() => ctx.onToggle(project, k)}>
                <Icon name="chevron-right" size={10} />
                <span className="nm">{title}</span>
                <span className="tagv">{t('tree.view.tag')}</span>
              </button>
              {ctx.editing && (
                <button className="x" aria-label={t('tree.view.removeLabel', { title, name })} title={t('tree.view.remove')} onClick={() => ctx.onRemove(project, k)}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
            {on && <div className="vb">{ctx.render(project, k)}</div>}
          </div>
        );
      })}
    </>
  );
}
