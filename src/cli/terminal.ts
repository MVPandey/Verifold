import type { Choice } from './choices.ts';
import { stripVTControlCharacters } from 'node:util';
import { wrapText } from './terminal-layout.ts';

// Colors from brand/exports/brand-tokens.css. Body text inherits the terminal theme.
export const palette = {
  violet: '124;58;237',
  lavender: '183;148;246',
  sky: '96;165;250',
  mint: '52;211;153',
} as const;
export type Tone = keyof typeof palette;

export function tint(
  value: string,
  color: boolean,
  tone: Tone = 'lavender',
): string {
  const plain = stripVTControlCharacters(value);
  return color ? `\u001b[38;2;${palette[tone]}m${plain}\u001b[0m` : plain;
}

export function muted(value: string, color: boolean): string {
  const plain = stripVTControlCharacters(value);
  return color ? `\u001b[2m${plain}\u001b[0m` : plain;
}

/** Leave a safe right gutter and keep prose readable in wide terminals. */
export function contentWidth(columns = 80): number {
  return Math.max(1, Math.min(72, columns - 5));
}

export function paragraph(value: string, columns = 80, indent = '  '): string {
  return wrapText(value, Math.max(1, Math.min(72, columns - indent.length - 1)))
    .map((line) => indent + line)
    .join('\n');
}

/** Render common agent Markdown while keeping code and terminal controls inert. */
export function terminalMessage(
  value: string,
  color: boolean,
  columns = 80,
): string {
  let fence: string | undefined;
  let headers: string[] | undefined;
  let separator = -1;
  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\||(?<!\\)\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replaceAll('\\|', '|'));
  const inline = (line: string): string =>
    line.replace(
      /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g,
      (_match: string, code: string | undefined, strong: string) =>
        code ?? strong,
    );
  return stripVTControlCharacters(value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap((line, index, lines) => {
      const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (
        marker &&
        (!fence || (marker[1]?.startsWith(fence) && !marker[2]?.trim()))
      ) {
        headers = undefined;
        fence = fence ? undefined : marker[1];
        return '';
      }
      if (!line.trim()) {
        headers = undefined;
        return '';
      }
      const spaces = line.match(/^\s*/)?.[0].replace(/\t/g, '  ').length ?? 0;
      const indent = ' '.repeat(Math.min(spaces, Math.max(0, columns - 8)));
      if (fence) return paragraph(line.trimStart(), columns, '    ' + indent);
      if (index === separator) return [];
      const rowCells = cells(line);
      const nextCells = cells(lines[index + 1] ?? '');
      if (
        rowCells.length > 1 &&
        nextCells.length === rowCells.length &&
        nextCells.every((cell) => /^:?-{3,}:?$/.test(cell))
      ) {
        headers = rowCells;
        separator = index + 1;
        return [];
      }
      const labels = headers;
      if (labels && rowCells.length === labels.length)
        return (
          rowCells
            .map((cell, position) =>
              paragraph(inline(`${labels[position]}: ${cell}`), columns),
            )
            .join('\n') + '\n'
        );
      headers = undefined;
      const heading = /^\s*#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line);
      if (heading)
        return tint(paragraph(inline(heading[1] ?? ''), columns), color, 'sky');
      const list = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(line);
      if (list) {
        const marker = /^[-+*]$/.test(list[1] ?? '') ? '• ' : `${list[1]} `;
        const prefix = '  ' + indent;
        return wrapText(
          inline(list[2] ?? ''),
          Math.max(
            1,
            Math.min(72, columns - prefix.length - marker.length - 1),
          ),
        )
          .map(
            (text, index) =>
              prefix + (index ? ' '.repeat(marker.length) : marker) + text,
          )
          .join('\n');
      }
      const row = paragraph(inline(line), columns, '  ' + indent);
      return line.startsWith('✓ ') ? tint(row, color, 'mint') : row;
    })
    .join('\n');
}

/** Compact folded VF silhouette with the approved wordmark and tagline. */
export function terminalBanner(
  interactive: boolean,
  noColor: boolean,
  columns = 80,
  frame = 2,
): string {
  if (!interactive) return '';
  const color = !noColor;
  const left = ['██▄   ', ' ▀██▄ ', '  ▀██▄', '   ▀██', '    ▀█'];
  const right = [' ▄██████', ' ███▀   ', '███▄▄▄  ', '██▀▀▀   ', '█▀      '];
  const aside = ['', 'verifold', '', 'Research beyond', 'the paper plane.'];
  const logo =
    columns >= 40
      ? left
          .map(
            (line, index) =>
              '  ' +
              tint(line, color, 'sky') +
              tint(
                right[index] ?? '',
                color,
                index === frame ? 'lavender' : 'violet',
              ) +
              '    ' +
              (index === 1
                ? tint(aside[index] ?? '', color)
                : muted(aside[index] ?? '', color)),
          )
          .join('\n')
      : paragraph('verifold', columns);
  return `\n${logo}\n\n${paragraph('Explore research questions with your AI agents.', columns)}\n${muted(paragraph('Verifold keeps your ideas, sources, and decisions together.', columns), color)}\n\n`;
}

/** Keep the active choice visible even in a short, narrow viewport. */
export function terminalMenu(
  question: string,
  choices: readonly Choice[],
  index: number,
  color: boolean,
  columns = 80,
  rows = 24,
): string {
  const width = contentWidth(columns);
  const lines = [tint(paragraph(question, columns), color), ''];
  choices.forEach((choice, position) => {
    wrapText(choice.label, Math.max(1, width - 2)).forEach((line, i) => {
      const row = (i ? '    ' : position === index ? '  ◆ ' : '  ○ ') + line;
      lines.push(position === index ? tint(row, color, 'sky') : row);
    });
  });
  lines.push(
    '',
    ...wrapText(choices[index]?.description ?? '', Math.max(1, width - 2)).map(
      (line) => muted('    ' + line, color),
    ),
    '',
    muted(paragraph('↑↓ move · enter select · esc cancel', columns), color),
  );
  const available = Math.max(1, rows - 2);
  const expanded = lines.join('\n').split('\n');
  if (expanded.length <= available) return expanded.join('\n');
  return [
    tint(
      paragraph(
        '◆ ' +
          (index + 1) +
          '/' +
          choices.length +
          ' · ' +
          (choices[index]?.label ?? ''),
        columns,
      ),
      color,
    ),
    muted(paragraph('↑↓ move · enter select · esc cancel', columns), color),
  ]
    .join('\n')
    .split('\n')
    .slice(0, available)
    .join('\n');
}
