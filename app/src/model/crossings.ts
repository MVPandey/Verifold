import type { AgentView, ThreadLink, ThreadSummary } from '../api/types.ts';
import { authorName } from './agents.ts';

/** How many of a card's links to other threads the wall names. */
export const SHOWN_LINKS = 2;

/** One link from a card to another thread: the thread, its title, and the agents on the other side. */
export interface CrossLine {
  readonly thread: string;
  readonly title: string;
  readonly agents: string;
}

/**
 * Return a card's links to other threads as lines, at most `SHOWN_LINKS`. The server sends the links with the
 * most crossings first. A link to a thread that the page does not have is left out.
 */
export function crossLines(
  links: readonly ThreadLink[],
  threads: readonly ThreadSummary[],
  agents: readonly AgentView[],
): readonly CrossLine[] {
  const titles = new Map(threads.map((summary) => [summary.thread.id, summary.thread.title]));
  return links
    .filter((link) => titles.has(link.thread))
    .slice(0, SHOWN_LINKS)
    .map((link) => ({
      thread: link.thread,
      title: titles.get(link.thread) ?? '',
      agents: [...new Set(link.agents.map((id) => authorName(agents, id)))].join(', '),
    }));
}

/** Return the wall's line about agents that built on each other's work, or `null` when none has yet. */
export function crossedLine(threads: readonly ThreadSummary[]): string | null {
  const count = threads.reduce((sum, summary) => sum + summary.crossed, 0);
  if (count === 0) return null;
  return count === 1
    ? 'One post builds on another agent’s work in another thread.'
    : `${count} posts build on another agent’s work in another thread.`;
}
