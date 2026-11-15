/** What decides how the app shows Markdown that an agent wrote: whether it parses the text, and what a link shows. */

/** The app parses no text that is longer. A typical text of this size takes about half a second. */
export const MAX_CHARS = 100_000;
/** The app parses no text with more lines. */
export const MAX_LINES = 5_000;
/** The deepest nesting of quotes and lists on one line that the app parses. Text that people read has a few. */
export const MAX_DEPTH = 30;

/** The quote and list markers that start a line, each of which opens a level of nesting. */
const CONTAINERS = /^(?:[ \t]*(?:>|[-+*](?=[ \t])|\d{1,9}[.)](?=[ \t])))+/;
const MARKER = />|[-+*]|\d+[.)]/g;
/** A long run of one mark that opens a link, an emphasis, or code, which makes the parser slow. */
const RUN = /([[(<`*_~])\1{199,}/;

/**
 * Return whether a text must show as plain text, because the Markdown parser would fail on it or take too long.
 *
 * The parser nests once for each quote or list marker on a line, and a few thousand of them overflow its stack,
 * which would take the page down. So a text that is very long, has very many lines, nests deeply on one line, or
 * holds a long run of one mark is never parsed.
 */
export function plainOnly(text: string): boolean {
  if (text.length > MAX_CHARS || RUN.test(text)) return true;
  const lines = text.split('\n');
  if (lines.length > MAX_LINES) return true;
  return lines.some((line) => {
    const lead = CONTAINERS.exec(line)?.[0];
    return lead !== undefined && (lead.match(MARKER)?.length ?? 0) > MAX_DEPTH;
  });
}

/**
 * Return the host of a link's target when the link's text is not the target itself, or `null` when it is.
 *
 * The app shows the host after such a link, so a link that reads as one site and leads to another does not
 * mislead. A target that is no valid address shows whole.
 */
export function linkHost(text: string, target: string): string | null {
  const bare = (value: string): string =>
    value
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/$/, '');
  if (bare(text) === bare(target)) return null;
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}
