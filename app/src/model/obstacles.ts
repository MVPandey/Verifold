import { PERSON } from '../api/types.ts';
import type { Obstacle, ObstacleState, ThreadSummary } from '../api/types.ts';
import { ago } from './format.ts';

/**
 * Return the facts of a thread's card: how long ago the newest result of its line came, and how many of its
 * obstacles are open when any are. A side thread, the conversation, and a thread of offers are no line of work,
 * so they have none.
 */
export function lineFacts(summary: ThreadSummary, now: Date): readonly string[] {
  const { thread, members, last_result_at: last, open_obstacles: open } = summary;
  if (members.length > 0 || thread.conversation || thread.deliverable) return [];
  const result = last ? `Last result ${ago(last, now)}` : 'No result yet';
  return open === 0
    ? [result]
    : [result, open === 1 ? '1 open obstacle' : `${open} open obstacles`];
}

/** The obstacles in one state, with the words of the group's row. */
export interface ObstacleGroup {
  readonly state: ObstacleState;
  readonly label: string;
  readonly items: readonly Obstacle[];
}

const STATES: readonly ObstacleState[] = ['open', 'taken_up', 'removed'];

const WORDS = { open: 'open', taken_up: 'taken up', removed: 'removed' } as const satisfies Record<
  ObstacleState,
  string
>;

/** Return the groups of the lab's obstacles that have any: open, taken up, and removed, in that order. */
export function obstacleGroups(obstacles: readonly Obstacle[]): readonly ObstacleGroup[] {
  return STATES.map((state) => {
    const items = obstacles.filter((item) => item.state === state);
    return { state, label: `${items.length} ${WORDS[state]}`, items };
  }).filter((group) => group.items.length > 0);
}

/**
 * Return the words of the link to the post that gives an obstacle its state, such as "Removed by Keel’s result",
 * or `null` for an open obstacle. The link names the newest such post, and the words count the others.
 */
export function builderLine(
  obstacle: Obstacle,
  called: (authorId: string) => string,
): { readonly id: string; readonly thread: string; readonly text: string } | null {
  const newest = obstacle.builders.at(-1);
  if (obstacle.state === 'open' || newest === undefined) return null;
  const how = obstacle.state === 'removed' ? 'Removed by' : 'Taken up by';
  const whose = newest.author === PERSON ? 'your' : `${called(newest.author)}’s`;
  const others = obstacle.builders.length - 1;
  const more = others === 0 ? '' : others === 1 ? ' and 1 more post' : ` and ${others} more posts`;
  return { id: newest.id, thread: newest.thread, text: `${how} ${whose} ${newest.kind}${more}` };
}
