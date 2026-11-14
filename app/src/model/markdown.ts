/** A piece of text inside a block. A link keeps only an http or https address, so a file cannot run a script. */
export type Inline =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'strong'; readonly parts: readonly Inline[] }
  | { readonly type: 'em'; readonly parts: readonly Inline[] }
  | { readonly type: 'link'; readonly href: string; readonly parts: readonly Inline[] };

/** One block of a Markdown file. */
export type Block =
  | { readonly type: 'heading'; readonly level: number; readonly parts: readonly Inline[] }
  | { readonly type: 'paragraph'; readonly parts: readonly Inline[] }
  | { readonly type: 'quote'; readonly parts: readonly Inline[] }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'rule' }
  | {
      readonly type: 'list';
      readonly ordered: boolean;
      readonly items: readonly { readonly depth: number; readonly parts: readonly Inline[] }[];
    }
  | {
      readonly type: 'table';
      readonly head: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    };

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)(?:[-*+]|(\d+)[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const INLINE =
  /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|\b_([^_\s][^_]*?)_\b|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>/;

/**
 * Return the blocks of a Markdown text: headings, paragraphs, lists, tables, quotes, rules, and fenced code.
 *
 * ponytail: this reads the Markdown that agents write for a person, not all of CommonMark. HTML and images stay
 * text. Use a library when a file needs more than this.
 */
export function parseMarkdown(text: string): readonly Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let at = 0;
  const line = (): string => lines[at] ?? '';
  const starts = (value: string): boolean =>
    FENCE.test(value) || HEADING.test(value) || ITEM.test(value) || RULE.test(value);
  while (at < lines.length) {
    const current = line();
    const fence = FENCE.exec(current)?.[1];
    const heading = HEADING.exec(current);
    if (!current.trim()) {
      at += 1;
    } else if (fence) {
      const code: string[] = [];
      for (at += 1; at < lines.length && !line().trim().startsWith(fence); at += 1)
        code.push(line());
      at += 1;
      blocks.push({ type: 'code', text: code.join('\n') });
    } else if (heading) {
      at += 1;
      blocks.push({
        type: 'heading',
        level: heading[1]?.length ?? 1,
        parts: inline(heading[2] ?? ''),
      });
    } else if (RULE.test(current)) {
      at += 1;
      blocks.push({ type: 'rule' });
    } else if (current.includes('|') && DIVIDER.test(lines[at + 1] ?? '')) {
      const head = cells(current);
      const rows: (readonly Inline[])[][] = [];
      for (at += 2; at < lines.length && line().includes('|') && line().trim(); at += 1) {
        rows.push(cells(line()));
      }
      blocks.push({ type: 'table', head, rows });
    } else if (ITEM.test(current)) {
      const ordered = ITEM.exec(current)?.[2] !== undefined;
      const items: { depth: number; text: string }[] = [];
      for (; at < lines.length; at += 1) {
        const item = ITEM.exec(line());
        const last = items.at(-1);
        if (item) {
          items.push({ depth: Math.floor((item[1] ?? '').length / 2), text: item[3] ?? '' });
        } else if (last && line().trim() && /^\s+/.test(line())) {
          // An indented line goes on with the item above it.
          last.text += ` ${line().trim()}`;
        } else if (!(line().trim() === '' && ITEM.test(lines[at + 1] ?? ''))) {
          break;
        }
      }
      blocks.push({
        type: 'list',
        ordered,
        items: items.map((item) => ({ depth: item.depth, parts: inline(item.text) })),
      });
    } else {
      const quote = current.trimStart().startsWith('>');
      const words: string[] = [];
      for (; at < lines.length && line().trim(); at += 1) {
        if (words.length > 0 && (starts(line()) || line().trimStart().startsWith('>') !== quote))
          break;
        words.push(quote ? line().replace(/^\s*>\s?/, '') : line().trim());
      }
      blocks.push({ type: quote ? 'quote' : 'paragraph', parts: inline(words.join(' ')) });
    }
  }
  return blocks;
}

function cells(row: string): (readonly Inline[])[] {
  const inner = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((cell) => inline(cell.trim().replace(/\\\|/g, '|')));
}

function inline(text: string): readonly Inline[] {
  const parts: Inline[] = [];
  let rest = text;
  for (let match = INLINE.exec(rest); match; match = INLINE.exec(rest)) {
    if (match.index > 0) parts.push({ type: 'text', text: rest.slice(0, match.index) });
    const [whole, , code, strong, strong2, em, em2, label, target, bare] = match;
    if (code !== undefined) parts.push({ type: 'code', text: code });
    else if (strong ?? strong2)
      parts.push({ type: 'strong', parts: inline(strong ?? strong2 ?? '') });
    else if (em ?? em2) parts.push({ type: 'em', parts: inline(em ?? em2 ?? '') });
    else if (bare) parts.push({ type: 'link', href: bare, parts: [{ type: 'text', text: bare }] });
    else if (label !== undefined && /^https?:\/\//i.test(target ?? ''))
      parts.push({ type: 'link', href: target ?? '', parts: inline(label) });
    // A link to anything else than a web page stays as its words.
    else parts.push(...inline(label ?? ''));
    rest = rest.slice(match.index + whole.length);
  }
  if (rest) parts.push({ type: 'text', text: rest });
  return parts;
}
