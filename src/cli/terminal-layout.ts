import { stripVTControlCharacters } from 'node:util';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A size that the terminal reported, or the default for a terminal that reports none or 0. */
function reportedSize(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

/**
 * A terminal's width in cells. A terminal that reports no width, or 0, as a
 * pseudo-terminal without a size does, gets the common default of 80.
 */
export function terminalColumns(columns: number | undefined): number {
  return reportedSize(columns, 80);
}

/** A terminal's height in rows, with the common default of 24 when it reports none or 0. */
export function terminalRows(rows: number | undefined): number {
  return reportedSize(rows, 24);
}

/** Remove terminal controls and invisible format characters, and expand tabs. */
export function plainText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
      character === '\n' || character === '\u200d' ? character : '',
    );
}

/** Common terminal cell widths; ambiguous-width characters use one cell. */
function cellWidth(value: string): number {
  if (/^[\p{Mark}\p{Cf}]+$/u.test(value)) return 0;
  if (/\p{Emoji_Presentation}|\uFE0F|\u20E3/u.test(value)) return 2;
  const point = value.codePointAt(0) ?? 0;
  return point >= 0x1100 &&
    (point <= 0x115f ||
      point === 0x2329 ||
      point === 0x232a ||
      (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe10 && point <= 0xfe19) ||
      (point >= 0xfe30 && point <= 0xfe6f) ||
      (point >= 0xff01 && point <= 0xff60) ||
      (point >= 0xffe0 && point <= 0xffe6) ||
      (point >= 0x20000 && point <= 0x3fffd))
    ? 2
    : 1;
}

/** Return the widest line in terminal cells, without VT or control sequences. */
export function visibleWidth(value: string): number {
  let widest = 0;
  for (const line of plainText(value).split('\n')) {
    let width = 0;
    for (const { segment } of graphemes.segment(line))
      width += cellWidth(segment);
    widest = Math.max(widest, width);
  }
  return widest;
}

/**
 * Wrap plain paragraphs without splitting graphemes. Explicit newlines remain.
 * A two-cell character becomes a replacement character in a one-cell column.
 */
export function wrapText(value: string, width: number): string[] {
  if (!Number.isSafeInteger(width) || width < 1)
    throw new RangeError('Text width must be a positive integer.');
  const lines: string[] = [];
  for (const paragraph of plainText(value).split('\n')) {
    let line = '';
    let used = 0;
    for (const word of paragraph.trim().split(/\s+/u).filter(Boolean)) {
      const wordWidth = visibleWidth(word);
      if (line && used + 1 + wordWidth <= width) {
        line += ` ${word}`;
        used += 1 + wordWidth;
        continue;
      }
      if (line) {
        lines.push(line);
        line = '';
        used = 0;
      }
      for (const { segment } of graphemes.segment(word)) {
        const cells = cellWidth(segment);
        const text = cells > width ? '\uFFFD' : segment;
        const size = Math.min(cells, width);
        if (used + size > width) {
          lines.push(line);
          line = '';
          used = 0;
        }
        line += text;
        used += size;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * One line of at most `width` cells: the text with its runs of white space
 * as one space, cut with "…" when it is wider. Graphemes stay whole.
 */
export function fitText(value: string, width: number): string {
  const line = plainText(value).replace(/\s+/gu, ' ').trim();
  if (visibleWidth(line) <= width) return line;
  if (width < 1) return '';
  let kept = '';
  let used = 0;
  for (const { segment } of graphemes.segment(line)) {
    const cells = cellWidth(segment);
    if (used + cells > width - 1) break;
    kept += segment;
    used += cells;
  }
  return `${kept.trimEnd()}…`;
}
