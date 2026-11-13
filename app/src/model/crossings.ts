import type { AgentView, ThreadLink, ThreadSummary } from '../api/types.ts';
import { authorName } from './agents.ts';

/** How many of a card's links to other threads the wall names before it counts the rest. */
export const SHOWN_LINKS = 2;

/** One link from a card to another thread: the thread, its title, and the agents on the other side. */
export interface CrossLine {
  readonly thread: string;
  readonly title: string;
  readonly agents: string;
}

/**
 * Return a card's links to other threads as lines, the ones with the most crossings first, and how many links
 * the lines leave out. A link to a thread that the page does not have is left out.
 */
export function crossLines(
  links: readonly ThreadLink[],
  threads: readonly ThreadSummary[],
  agents: readonly AgentView[],
): { readonly lines: readonly CrossLine[]; readonly more: number } {
  const titles = new Map(threads.map((summary) => [summary.thread.id, summary.thread.title]));
  const known = links
    .filter((link) => titles.has(link.thread))
    .sort((first, second) => second.posts - first.posts);
  const lines = known.slice(0, SHOWN_LINKS).map((link) => ({
    thread: link.thread,
    title: titles.get(link.thread) ?? '',
    agents: [...new Set(link.agents.map((id) => authorName(agents, id)))].join(', '),
  }));
  return { lines, more: known.length - lines.length };
}

/** Return how many times an idea crossed between agents and threads in the whole lab. */
export function crossed(threads: readonly ThreadSummary[]): number {
  return threads.reduce(
    (sum, summary) => sum + summary.builds_on.reduce((links, link) => links + link.posts, 0),
    0,
  );
}

/** Return the wall's line about crossings, or `null` when no idea has crossed yet. */
export function crossedLine(threads: readonly ThreadSummary[]): string | null {
  const count = crossed(threads);
  if (count === 0) return null;
  return count === 1
    ? 'One idea has crossed from one agent’s thread into another’s.'
    : `Ideas have crossed between agents’ threads ${count} times.`;
}
