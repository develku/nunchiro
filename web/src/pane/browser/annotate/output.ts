// Adapted from Orca src/renderer/src/components/browser-pane/annotate/browser-annotation-output.ts
// (https://github.com/stablyai/orca, commit 2eb0bb637dff41925d8ffa22ff9054ab656e4816). MIT License, Copyright (c) 2026 Lovecast Inc.
// Changes: trimmed payload (no computed styles, React or source fields), page text capped at 500 characters per field
// (threat model A12), selector, classes and HTML capped too, all page text quoted in backtick-safe code spans or fences.

/** The element a guest page reports. Field names follow Orca's BrowserGrabPayload so the Markdown block stays Orca-format. */
export interface PickedElement {
  page: { sanitizedUrl: string; viewportWidth: number; viewportHeight: number };
  target: {
    tagName: string;
    selector: string;
    textSnippet?: string;
    accessibleName?: string;
    cssClasses?: string;
    elementPath?: string;
    htmlSnippet?: string;
    rectViewport: { x: number; y: number; width: number; height: number };
  };
  nearbyText: string[];
}
export interface BrowserAnnotation {
  browserPageId: string;
  payload: PickedElement;
  comment: string;
}

/** A12: page-controlled text is cut to this many characters per field. */
export const ANNOTATION_TEXT_MAX = 500;

/** Collapses whitespace runs and cuts to `max` characters (by code point). */
function inlineText(content: string, max = ANNOTATION_TEXT_MAX): string {
  return [...content.replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}

function maxBacktickRun(content: string, floor: number): number {
  let max = floor;
  for (const run of content.match(/`+/g) ?? []) max = Math.max(max, run.length);
  return max;
}
function fence(language: string, content: string): string[] {
  const marker = '`'.repeat(maxBacktickRun(content, 3) + 1);
  return [`${marker}${language}`, content, marker];
}
function inlineCode(content: string): string {
  const marker = '`'.repeat(maxBacktickRun(content, 0) + 1);
  const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : '';
  return `${marker}${pad}${content}${pad}${marker}`;
}
const quoted = (content: string) => inlineCode(inlineText(content));

function pageHeading(p: PickedElement): string {
  try {
    const url = new URL(p.page.sanitizedUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return p.page.sanitizedUrl || 'current page';
  }
}

function elementLabel(p: PickedElement): string {
  const { tagName, accessibleName, textSnippet } = p.target;
  const text = accessibleName || textSnippet;
  return text ? `${tagName} ${quoted(text.slice(0, 60))}` : tagName;
}

export function formatBrowserAnnotationsAsMarkdown(annotations: BrowserAnnotation[]): string {
  if (annotations.length === 0) return '';
  const first = annotations[0];
  const groups = new Map<string, { annotation: BrowserAnnotation; index: number }[]>();
  annotations.forEach((annotation, index) => {
    const url = annotation.payload.page.sanitizedUrl;
    groups.set(url, [...(groups.get(url) ?? []), { annotation, index }]);
  });
  const mixed = groups.size > 1;
  const lines: string[] = mixed
    ? ['## Design Feedback across pages', '']
    : [
        `## Design Feedback: ${inlineText(pageHeading(first.payload))}`,
        '',
        `**URL:** ${quoted(first.payload.page.sanitizedUrl)}`,
        `**Browser tab id:** ${first.browserPageId}`,
        `**Viewport:** ${first.payload.page.viewportWidth}x${first.payload.page.viewportHeight}`,
        ''
      ];

  for (const [url, entries] of groups) {
    if (mixed) lines.push(`## Design Feedback: ${inlineText(pageHeading(entries[0].annotation.payload))}`, '', `**URL:** ${quoted(url)}`, '');
    for (const { annotation, index } of entries) {
      const { payload } = annotation;
      const { target } = payload;
      const rect = target.rectViewport;
      lines.push(`### ${index + 1}. ${elementLabel(payload)}`);
      if (mixed) lines.push(`**Browser tab id:** ${quoted(annotation.browserPageId)}`, `**Viewport:** ${payload.page.viewportWidth}x${payload.page.viewportHeight}`);
      lines.push(`**Selector:** ${quoted(target.selector)}`);
      if (target.elementPath) lines.push(`**Location:** ${quoted(target.elementPath)}`);
      lines.push(`**Bounds:** x=${Math.round(rect.x)}, y=${Math.round(rect.y)}, ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      if (target.cssClasses) lines.push(`**Classes:** ${quoted(target.cssClasses)}`);
      if (target.textSnippet) lines.push(`**Text:** ${quoted(target.textSnippet)}`);
      if (payload.nearbyText.length > 0) lines.push('**Nearby text:**', ...payload.nearbyText.map((t) => `- ${quoted(t)}`));
      if (target.htmlSnippet) lines.push('**HTML:**', ...fence('html', target.htmlSnippet.slice(0, ANNOTATION_TEXT_MAX)));
      lines.push(`**Feedback:** ${inlineText(annotation.comment)}`, '');
    }
  }
  return lines.join('\n').trimEnd();
}
