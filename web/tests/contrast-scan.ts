/** Visible text below WCAG AA (4.5:1, or 3:1 at 18.66px bold / 24px) against what is behind it. The text and each
 *  ancestor's fill are composited up the whole ancestor chain, and each ancestor's `opacity` fades everything inside
 *  it into what is behind it, as the browser draws it (tickets 499, 525). Runs in the page (`page.evaluate`), so it
 *  must stay self-contained.
 *  shortcut: images and gradients behind text are not seen, nor fills of elements that overlap without being an
 *  ancestor (a popover's own fill is an ancestor, so menus are measured); the report gives the measured pair. A cheap
 *  check for those needs pixels (a screenshot per text node); add one if a sweep shows a miss. */
export function lowContrast() {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  // Straight-alpha RGBA, channels 0..255, alpha 0..1. color-mix() computes to `color(srgb r g b / a)` with 0..1
  // channels. Any other space (oklch, lab, display-p3) is painted into a 1x1 canvas, which converts it to sRGB; the
  // alpha is read from the string and dropped before painting, so the channels keep their full precision.
  const rgba = (c: string): number[] => {
    const v = (c.match(/[\d.]+/g) ?? []).map(Number);
    if (c.startsWith('rgb')) return [v[0], v[1], v[2], v[3] ?? 1];
    if (c.startsWith('color(srgb')) return [v[0] * 255, v[1] * 255, v[2] * 255, v[3] ?? 1];
    const alpha = c.match(/\/\s*([\d.]+)(%?)\s*\)$/);
    const a = alpha ? +alpha[1] / (alpha[2] ? 100 : 1) : 1;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c.replace(/\/[^)]*\)$/, ')');
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a];
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  // Source-over of two straight-alpha colours.
  const over = (t: number[], u: number[]) => {
    const a = t[3] + u[3] * (1 - t[3]);
    return a === 0 ? [0, 0, 0, 0] : [0, 1, 2].map((i) => (t[i] * t[3] + u[i] * u[3] * (1 - t[3])) / a).concat(a);
  };
  // Text and the fill behind it, each composited from `el` up to the root. An ancestor's opacity scales the composite
  // of its subtree, so text and fill fade together (multiplying it into the text alone would be wrong over a fill).
  // Null when an ancestor's opacity is 0: the text is not drawn (a row's hover-only buttons).
  const pair = (el: Element, color: string): number[][] | null => {
    let fore = rgba(color);
    let back = [0, 0, 0, 0];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      const fill = rgba(s.backgroundColor);
      fore = over(fore, fill);
      back = over(back, fill);
      const o = +s.opacity;
      if (o === 0) return null;
      if (o < 1) (fore[3] *= o), (back[3] *= o);
    }
    const page = [255, 255, 255, 1];
    return [over(fore, page), over(back, page)];
  };
  const css = (c: number[]) => `rgb(${c.slice(0, 3).map((v) => Math.round(v)).join(', ')})`;
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    const text = n.textContent?.trim();
    if (!el || !text || el.closest('iframe, .xterm, [aria-hidden="true"]')) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (s.visibility === 'hidden' || r.width === 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const drawn = pair(el, s.color);
    if (!drawn) continue;
    const [fore, back] = drawn;
    const [a, b] = [lum(fore), lum(back)];
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.66 && +s.fontWeight >= 700);
    const disabled = !!el.closest(':disabled, [aria-disabled="true"]');
    if (ratio >= (large ? 3 : 4.5) || disabled) continue;
    // Floored, never rounded: 4.497 must not print as a passing "4.50".
    const line = `${(Math.floor(ratio * 100) / 100).toFixed(2)}\t${css(fore)} on ${css(back)}\t${el.tagName.toLowerCase()}.${[...el.classList].join('.')}\t${text.slice(0, 40)}`;
    if (!seen.has(line)) seen.add(line), out.push(line);
  }
  return out;
}
