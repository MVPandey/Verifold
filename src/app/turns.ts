import type { Step, Turn } from '../protocol/api.ts';

/**
 * Turns read on request, older than the snapshot's page. They end right
 * before the turn `anchor`: the first turn of the snapshot's page when the
 * first of them was read.
 */
export interface Older {
  readonly turns: readonly Turn[];
  /** Turns older than these exist. */
  readonly more: boolean;
  readonly anchor: string;
}

/** Turns from several reads as one list, oldest first. A turn read twice shows once, with its last copy. */
export function byStart(lists: readonly (readonly Turn[])[]): readonly Turn[] {
  const byId = new Map<string, Turn>();
  for (const list of lists) for (const turn of list) byId.set(turn.id, turn);
  return [...byId.values()].sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
  );
}

/**
 * The older turns and the snapshot's newest page as one list, with no turn
 * left out. New turns can push the anchor out of the snapshot's page. Then
 * the turns between the two are in neither list, and `gap` names the turn
 * to read pages before until the anchor shows again. Until then, `turns`
 * is the newest page alone.
 */
export function joinTurns(
  older: Older | null,
  newest: readonly Turn[],
): { readonly turns: readonly Turn[]; readonly gap: string | null } {
  const first = newest[0];
  if (!older || !first) return { turns: newest, gap: null };
  return newest.some((turn) => turn.id === older.anchor)
    ? { turns: byStart([older.turns, newest]), gap: null }
    : { turns: newest, gap: first.id };
}

/**
 * `older` with the pages that filled its gap, now ending before `anchor`.
 * Null when the pages never reached the old anchor, as after the agent's
 * conversation started again: the older turns are then out of reach.
 */
export function filled(
  older: Older,
  pages: readonly (readonly Turn[])[],
  anchor: string,
): Older | null {
  const reached = pages.some((page) =>
    page.some((turn) => turn.id === older.anchor),
  );
  return reached
    ? { turns: byStart([older.turns, ...pages]), more: older.more, anchor }
    : null;
}

/** Steps from several pages as one list, by their place in the turn. A step read twice shows once, with its last copy. */
export function byIndex(lists: readonly (readonly Step[])[]): readonly Step[] {
  const byPlace = new Map<number, Step>();
  for (const list of lists)
    for (const step of list) byPlace.set(step.index, step);
  return [...byPlace.values()].sort((a, b) => a.index - b.index);
}

/** Whether earlier steps still meet the newest page, so that no step falls between them. */
export function meet(
  earlier: readonly Step[],
  newest: readonly Step[],
): boolean {
  const last = earlier.at(-1);
  const first = newest[0];
  return !last || !first || last.index + 1 >= first.index;
}

/**
 * Where a run that a link names shows among an agent's turns: `shown` in a
 * turn on the page, `older` when turns not read yet may hold it, or
 * `absent` when no turn of the agent started it.
 */
export function runPlace(
  run: string,
  turns: readonly Turn[],
  older: boolean,
): 'shown' | 'older' | 'absent' {
  if (turns.some((turn) => turn.runs?.includes(run))) return 'shown';
  return older ? 'older' : 'absent';
}
