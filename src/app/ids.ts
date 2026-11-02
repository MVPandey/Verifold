import { href } from './route.ts';

/** The IDs of records that a person can open. A path or a longer word that holds one is no ID. */
const id = String.raw`(?:[dprc]|lease)-[1-9]\d*`;

const ids = new RegExp(String.raw`(?<![\w./-])${id}(?![\w/-])`, 'g');

/** A list of IDs in brackets, or after a colon before a closing bracket, as Verifold writes them. */
const marks = new RegExp(
  String.raw`\s*\(${id}(?:, ${id})*\)|: ${id}(?:, ${id})*(?=\))`,
  'g',
);

/** An ID in a text, with where it leads. */
export interface IdLink {
  readonly id: string;
  /** Its page, or null for a call, which opens over this page. */
  readonly href: string | null;
}

function link(value: string): IdLink {
  switch (value.charAt(0)) {
    case 'd':
      return { id: value, href: href.direction(value) };
    case 'r':
      return { id: value, href: href.runPage(value) };
    case 'p':
      return { id: value, href: href.post(value) };
    case 'c':
      return { id: value, href: null };
    default:
      // A lease is a pod, and the pods are in Settings.
      return { id: value, href: href.settings };
  }
}

/** A text, cut at its IDs. */
export function idParts(text: string): readonly (string | IdLink)[] {
  const parts: (string | IdLink)[] = [];
  let at = 0;
  for (const match of text.matchAll(ids)) {
    if (match.index > at) parts.push(text.slice(at, match.index));
    parts.push(link(match[0]));
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** Verifold's text with the IDs that it adds taken out, for the Simple view: "(p-155)", or ": r-7" in "(1 failed: r-7)". */
export function withoutIds(text: string): string {
  return text.replace(marks, '');
}
