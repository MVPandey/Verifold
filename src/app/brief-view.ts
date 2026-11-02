import type { Away, Brief, BriefLine, Lab, Thread } from '../protocol/api.ts';
import { shortTime, since } from './format.ts';
import { href } from './route.ts';
import type { ViewMode } from './view-mode.ts';

/** A line's word on the home. An answer and a story's lines show elsewhere. */
export const lineWords: Readonly<Record<BriefLine['kind'], string>> = {
  decided: 'Decided',
  failed: 'Failed',
  held: 'Held up',
  result: 'Result',
  open: 'Open',
  new: 'New',
  answer: 'Answer',
  step: 'Step',
  outcome: 'Outcome',
  later: 'Later',
};

/** The cited posts, each its own quote and unchanged. Technical adds each post's ID after it, and an agent's own IDs stay in both views. */
export function quoteTexts(
  line: Pick<BriefLine, 'quotes'>,
  mode: ViewMode,
): readonly string[] {
  return line.quotes.map(({ post, text }) =>
    mode === 'technical' ? `${text} (${post})` : text,
  );
}

/**
 * The plain words that a line shows. Null: it shows its quotes. Technical
 * quotes its posts, but the person's own question gets its answer as written
 * in both views. Simple shows the plain words, unless the line has none or the
 * person asked for the original.
 */
export function shownPlain(
  line: Pick<BriefLine, 'kind' | 'plain'>,
  mode: ViewMode,
  original: boolean,
): string | null {
  return original || (mode === 'technical' && line.kind !== 'answer')
    ? null
    : line.plain;
}

/** A line has a way to its quote only where it shows plain words. */
export function hasOriginal(
  line: Pick<BriefLine, 'kind' | 'plain'>,
  mode: ViewMode,
): boolean {
  return shownPlain(line, mode, false) !== null;
}

/** Where a line's Thread link leads: its thread, or its first post in a lab's older posts. */
export function lineHref(line: Pick<BriefLine, 'thread' | 'posts'>): string {
  const [post] = line.posts;
  if (line.thread) return href.thread(line.thread);
  return post ? href.post(post) : href.threads;
}

/** The top line of a view. Both come from one reading of the records. */
export function topLine(
  brief: Pick<Brief, 'top' | 'topIds'>,
  mode: ViewMode,
): string {
  return mode === 'technical' && brief.topIds ? brief.topIds : brief.top;
}

/** The threads with a decision. */
export function decisionCount(threads: readonly Thread[] = []): number {
  return threads.filter((thread) => thread.state === 'decided').length;
}

/** The head of the brief: since when, and who wrote it and how long ago. A brief older than the person's return does not cover their time away. */
export function briefHead(
  lab: Pick<Lab, 'away'> & { readonly brief: Brief },
  now: number,
): string {
  const { away, brief } = lab;
  const covers = away && (!brief.at || brief.at >= away.since);
  const left = covers
    ? `Since you left at ${shortTime(away.since, now)}`
    : null;
  const written = brief.at
    ? `Coordinator, ${shortTime(brief.at, now)}, ${since(brief.at, now)} ago`
    : null;
  return [left, written].filter(Boolean).join(' · ') || 'Where the lab stands';
}

/**
 * The foot of the brief: where its words come from. Simple names the check,
 * or why a line quotes its posts. Technical says that each line quotes them.
 * `lines`: those that show. Null: no lines.
 */
export function briefFoot(
  lines: readonly BriefLine[],
  mode: ViewMode,
): string | null {
  if (!lines.length) return null;
  if (mode === 'technical')
    return lines.length === 1
      ? 'The line above quotes its posts unchanged.'
      : `The ${lines.length} lines above quote their posts unchanged.`;
  const plain = lines.filter((line) => line.plain !== null);
  const posts = new Set(plain.flatMap((line) => line.posts)).size;
  const checker = plain.some((line) => line.check.sameHarness)
    ? 'a second session of the same harness'
    : 'a second agent';
  const states = (...list: readonly string[]): number =>
    lines.filter((line) => list.includes(line.check.state)).length;
  const waiting = states('pending');
  const failed = states('failed', 'numbers');
  const withheld = states('withheld');
  return [
    ...(plain.length
      ? [
          `Plain words from ${posts} ${posts === 1 ? 'post' : 'posts'}, checked by ${checker}.`,
        ]
      : []),
    ...(waiting === 1
      ? ['1 line quotes its posts until a second agent checks it.']
      : waiting
        ? [
            `${waiting} lines quote their posts until a second agent checks them.`,
          ]
        : []),
    ...(failed === 1
      ? ['1 line failed its check, so it quotes its posts.']
      : failed
        ? [`${failed} lines failed their checks, so they quote their posts.`]
        : []),
    ...(withheld ? ['This lab keeps no plain words.'] : []),
  ].join(' ');
}

type News = NonNullable<Away['news']>;

/** What the time away says when nothing came. Null: something came. */
export function quietWords(news: News): string | null {
  if (news.lines.length || news.counts) return null;
  return news.cost ? 'No post, run, or call came.' : 'Nothing changed.';
}

/** The counts of a time away. They are Verifold's own words, so Simple can drop the run IDs: "(1 failed: r-7)" reads "(1 failed)". */
export function countsWords(counts: string, ids: boolean): string {
  return ids ? counts : counts.replace(/( failed): [^)]*\)/, '$1)');
}
