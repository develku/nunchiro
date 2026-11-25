// Ticket 1065: CommonMark does not close **strong** when the closing ** follows punctuation and precedes a CJK letter
// (호스트를 **`macbook`**으로, **"인용"**은). This remark transformer closes those by hand.
// shortcut: strong only, replace with remark-cjk-friendly once the gate installs new packages
// Known limit: parsed text has lost its backslashes, so an escaped \*\*x\*\* before a CJK letter also becomes strong.
type Node = { type: string; value?: string; children?: Node[] };

// Hangul, Kana, Han, CJK punctuation (U+3000 to U+303F) and full-width forms (U+FF00 to U+FFEF).
const CJK = String.raw`[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}　-〿＀-￯]`;
const INSIDE = new RegExp(`\\*\\*([^*\\s](?:[^*]*[^*\\s])?)\\*\\*(?=${CJK})`, 'u');
const CLOSER = new RegExp(`^\\*\\*(?=${CJK})`, 'u');

const text = (value: string): Node => ({ type: 'text', value });

function fix(kids: Node[]): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < kids.length; i++) {
    let n = kids[i];
    // (a) both pairs of asterisks inside one text node.
    while (n.type === 'text' && n.value) {
      const m = INSIDE.exec(n.value);
      if (!m) break;
      if (m.index) out.push(text(n.value.slice(0, m.index)));
      out.push({ type: 'strong', children: [text(m[1])] });
      n = text(n.value.slice(m.index + m[0].length));
    }
    // (b) the opener ends a text node, the closer starts a later one, other nodes (inline code, a link) lie between.
    if (n.type === 'text' && n.value?.endsWith('**') && !n.value.endsWith('***')) {
      const j = kids.findIndex((k, at) => at > i + 1 && k.type === 'text' && CLOSER.test(k.value ?? ''));
      if (j > 0) {
        const head = n.value.slice(0, -2);
        if (head) out.push(text(head));
        out.push({ type: 'strong', children: fix(kids.slice(i + 1, j)) });
        kids[j] = text(kids[j].value!.slice(2));
        i = j - 1;
        continue;
      }
    }
    if (n.value !== '') out.push(n.children ? { ...n, children: fix(n.children) } : n);
  }
  return out;
}

export function remarkCjkStrong() {
  return (tree: Node) => {
    tree.children = fix(tree.children ?? []);
  };
}
