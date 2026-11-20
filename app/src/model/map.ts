import type { BranchLine, BranchView, IdeaState, IdeaView, MapView } from '../api/types.ts';
import { duration } from './format.ts';

/** The words of each state of an idea, as the person reads them. */
export const STATE_WORDS = {
  untried: 'untried',
  being_tried: 'being tried',
  result_in: 'result in',
  challenged: 'challenged',
  ruled_out: 'ruled out',
} as const satisfies Record<IdeaState, string>;

/** The class of the mark of each state of an idea: a ruled-out idea is bad, a challenged one turns, others are plain. */
export const STATE_TONES = {
  untried: 'fs-none',
  being_tried: '',
  result_in: '',
  challenged: 'fs-ask',
  ruled_out: 'fs-count-bad',
} as const satisfies Record<IdeaState, string>;

/** Return whether the lab page offers the Map tab: the lab's readings added a branch. */
export function hasMap(map: MapView | undefined): boolean {
  return (map?.branches.length ?? 0) > 0;
}

/**
 * Return the counts of a branch with ideas as one line, such as "6 ideas · 2 being tried · 1 result · 3 ruled
 * out". A count of zero is left out. A branch without an idea has `emptyMark` instead.
 */
export function branchCounts(branch: BranchLine): string {
  const ideas = branch.ideas ?? 0;
  const counts: readonly (readonly [number, string, string])[] = [
    [ideas, 'idea', 'ideas'],
    [branch.being_tried ?? 0, 'being tried', 'being tried'],
    [branch.results ?? 0, 'result', 'results'],
    [branch.ruled_out ?? 0, 'ruled out', 'ruled out'],
  ];
  return counts
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`)
    .join(' · ');
}

/**
 * Return the mark of a branch on which no idea hangs, such as "No idea yet · 6 h", with how long it has had none
 * since the reading that added it. `null` for a branch with ideas.
 */
export function emptyMark(branch: BranchLine): string | null {
  if ((branch.ideas ?? 0) > 0) return null;
  const hours = branch.no_idea_hours;
  return hours == null ? 'No idea yet' : `No idea yet · ${duration(Math.round(hours * 60))}`;
}

/** Return the branches in force, in the readings' order, and the retired ones, in the same order. */
export function splitBranches(map: MapView): {
  readonly inForce: readonly BranchView[];
  readonly retired: readonly BranchView[];
} {
  return {
    inForce: map.branches.filter((branch) => branch.retired !== true),
    retired: map.branches.filter((branch) => branch.retired === true),
  };
}

/** Return the idea that an idea hangs on, when it hangs on another idea and the map holds that one. */
export function parentIdea(map: MapView, idea: IdeaView): IdeaView | null {
  const parent = idea.parent;
  if (!parent?.startsWith('p-')) return null;
  for (const branch of map.branches) {
    const found = branch.idea_list?.find((item) => item.id === parent);
    if (found) return found;
  }
  return null;
}

/** One line of a card that names who did something to an idea, and leads to the post. */
export interface DeedLine {
  readonly post: string;
  readonly thread: string;
  readonly who: string;
  readonly text: string;
  readonly mark: string;
  /** The class of the mark. */
  readonly tone: string;
}

/** Return who tried an idea: each plan and result that tries it, oldest first, with its kind as its mark. */
export function triedBy(idea: IdeaView, name: (authorId: string) => string): readonly DeedLine[] {
  return (idea.tries ?? []).map((item) => ({
    post: item.post,
    thread: item.thread,
    who: name(item.author),
    text: item.text,
    mark: item.kind,
    tone: item.standing === 'disputed' ? 'fs-count-bad' : '',
  }));
}

/** Return who challenged the results that try an idea, oldest first, with each challenge's outcome as its mark. */
export function challengedBy(
  idea: IdeaView,
  name: (authorId: string) => string,
): readonly DeedLine[] {
  return (idea.challenges ?? []).map((item) => ({
    post: item.post,
    thread: item.thread,
    who: name(item.author),
    text: item.text,
    mark: item.outcome,
    tone: item.outcome === 'holds' ? 'fs-ok' : 'fs-count-bad',
  }));
}
