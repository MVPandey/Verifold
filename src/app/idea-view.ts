import type { IdeaPage, Lab, LabShare, Shot } from '../protocol/api.ts';
import { harnessName, shortTime } from './format.ts';
import type { ViewMode } from './view-mode.ts';

type Idea = IdeaPage['ideas'][number];
type Draw = IdeaPage['draws'][number];

/** The ideas that the lab tried, and those that it did not. */
export function ideaGroups(page: Pick<IdeaPage, 'ideas'>): {
  readonly tried: readonly Idea[];
  readonly untried: readonly Idea[];
} {
  return {
    tried: page.ideas.filter((idea) => idea.tried),
    untried: page.ideas.filter((idea) => !idea.tried),
  };
}

/** "10 of the lab's ideas", or "300 of the lab's 512 ideas" for a map that the page cuts. */
export function ideaHead(page: Pick<IdeaPage, 'ideas' | 'ideaCount'>): string {
  const shown = page.ideas.length;
  return page.ideaCount > shown
    ? `${shown} of the lab's ${page.ideaCount} ideas`
    : `${shown} of the lab's ideas`;
}

/** The tag of a long shot in a view. */
export function shotTag(mode: ViewMode): string {
  return mode === 'simple' ? 'Long shot' : 'Alien';
}

/** "Candidates drawn at 16:31, after a failed line of work". */
export function drawHead(draw: Pick<Draw, 'at' | 'by'>, now: number): string {
  return `Candidates drawn at ${shortTime(draw.at, now)}, ${draw.by === 'person' ? 'after your Draw again' : 'after a failed line of work'}`;
}

/** What a draw left on the board, when it left nothing. */
export function drawEmpty(draw: Pick<Draw, 'judged' | 'shots'>): string | null {
  if (draw.shots.length) return null;
  return draw.judged
    ? 'No candidate from this draw went on the board.'
    : 'No judgment came from this draw.';
}

/** What makes up a long shot, what its judge said, and what its search found. All of it comes from the record. */
export function shotLine(shot: Shot): string {
  const papers =
    shot.prior === 0
      ? 'no paper combines these ideas'
      : `${shot.prior} ${shot.prior === 1 ? 'paper combines' : 'papers combine'} these ideas`;
  return [
    `${shot.ideas.join(' + ')}.`,
    `Judge (${harnessName(shot.harness)}): ${shot.sense} of 5 for sense. Test: ${shot.test}`,
    `Cost: ${shot.cost}.`,
    `Search: ${papers}. Closest: ${shot.closest}.`,
  ].join(' ');
}

const shareWords: Readonly<Record<LabShare, string>> = {
  close: 'Close to known work',
  mixed: 'Mixed',
  far: 'Far',
};

/** Who works on long shots, and on what terms. */
export function shareLine(lab: Pick<Lab, 'directions' | 'share'>): string {
  const open = lab.directions.filter((entry) => entry.state === 'open');
  const shots = open.filter((entry) => entry.longShot).length;
  return [
    `${shots} of ${open.length} agents work on long shots, and they choose what to take up.`,
    'An agent sets a pass mark before any run, and its results get the same checks as every other result.',
    lab.share
      ? `You chose ${shareWords[lab.share]} when you asked.`
      : 'This lab has no share, because it started before that choice.',
  ].join(' ');
}

/** What the draws do now. Null: nothing to say. */
export function drawState(
  page: Pick<IdeaPage, 'stopped' | 'drawing'>,
): string | null {
  if (page.drawing === 'running')
    return 'A session of the other harness judges a draw now.';
  if (page.drawing === 'waiting')
    return 'A draw waits for a free slot. In a full lab it may never run.';
  return page.stopped
    ? 'You stopped long shots. A failed line of work starts no draw until you draw again.'
    : null;
}

/** What nobody has tested. */
export const untestedLine =
  "The check on these ideas is ours, and nobody has tested it against the paper's method. Agents and search stand in for the paper's models.";
