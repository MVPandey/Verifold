import type { Brief, BriefLine, Lab } from '../protocol/api.ts';
import { clock, dayClock, since } from './format.ts';
import { withoutIds } from './ids.ts';
import { href } from './route.ts';
import type { ViewMode } from './view-mode.ts';

/** A line's word on the home. An answer and a story's lines show elsewhere. */
export const lineWords: Readonly<Record<BriefLine['kind'], string>> = {
  decided: 'Decided',
  failed: 'Failed',
  held: 'Held up',
  open: 'Open',
  new: 'New',
  answer: 'Answer',
  step: 'Step',
  outcome: 'Outcome',
  later: 'Later',
};

/** A clock time, with its day when it is not today. */
export function shortTime(at: string, now: number): string {
  return dayClock(at, now).replace(/^today at /, '');
}

/**
 * The words that a line shows. Technical quotes its posts unchanged. Simple
 * shows the plain words, or the quote with no IDs of Verifold's when the line
 * has no plain words yet, or when the person asked for the original.
 */
export function lineText(
  line: Pick<BriefLine, 'plain' | 'quote'>,
  mode: ViewMode,
  original: boolean,
): string {
  if (mode === 'technical') return line.quote;
  return original || line.plain === null ? withoutIds(line.quote) : line.plain;
}

/** Where a line's Thread link leads: its thread, or its first post in a lab's older posts. */
export function lineHref(line: Pick<BriefLine, 'thread' | 'posts'>): string {
  const [post] = line.posts;
  if (line.thread) return href.thread(line.thread);
  return post ? href.post(post) : href.threads;
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
    ? `Coordinator, ${clock(brief.at)}, ${since(brief.at, now)} ago`
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
