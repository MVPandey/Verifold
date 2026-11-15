/** What the lab page says about the person's deliverables: the counts, each state, and each offer. */

import type { AgentView, Deliverable, DeliverableOffer } from '../api/types.ts';
import { authorName } from './agents.ts';
import { dayClock } from './format.ts';

/** The most characters in a deliverable's sentence, as `MAX_SENTENCE` in the server's `protocol/deliverables.py`. */
export const MAX_SENTENCE = 300;

/** The most deliverables that a lab has at one time, as `MAX_DELIVERABLES` in the server. */
export const MAX_DELIVERABLES = 20;

/** One count of the line that opens the panel, such as 1 and "with no file yet". */
export interface Count {
  readonly count: number;
  readonly label: string;
}

/**
 * Return the counts of the deliverables by state, in the order that the line shows them. The count of the ones
 * where the person asked for changes is in the list only when it is above zero.
 */
export function deliverCounts(list: readonly Deliverable[]): readonly Count[] {
  const count = (state: Deliverable['state']): number =>
    list.filter((item) => item.state === state).length;
  const changes = count('changes_asked');
  return [
    { count: count('accepted'), label: 'accepted' },
    { count: count('offered'), label: 'offered' },
    ...(changes > 0 ? [{ count: changes, label: 'with changes asked' }] : []),
    { count: count('none'), label: 'with no file yet' },
  ];
}

/**
 * Return the line that the close banner adds about the deliverables, or `null` when the person stated none. It
 * states counts only: the agents can close a lab whatever the counts are.
 */
export function deliverLine(list: readonly Deliverable[]): string | null {
  if (list.length === 0) return null;
  const counts = deliverCounts(list)
    .map((item) => `${item.count} ${item.label}`)
    .join(', ');
  return `Your deliverables: ${counts}.`;
}

/** Return the one state of a deliverable in words, with the time of the person's decision when it has one. */
export function stateLine(item: Deliverable, now: Date): string {
  const at = item.decided_at ? ` at ${dayClock(item.decided_at, now)}` : '';
  switch (item.state) {
    case 'accepted':
      return `Accepted by you${at}`;
    case 'offered':
      return 'Offered, not accepted yet';
    case 'changes_asked':
      return `You asked for changes${at}`;
    case 'none':
      return 'No file yet';
  }
}

/** Return who offered a file and when, such as "Offered by Maren. Revised 12 times, last at 03:10." */
export function offerLine(
  offer: DeliverableOffer,
  agents: readonly AgentView[],
  now: Date,
): string {
  const at = dayClock(offer.at, now);
  const when =
    offer.revised === 0
      ? `Written at ${at}`
      : `Revised ${offer.revised === 1 ? 'once' : `${offer.revised} times`}, last at ${at}`;
  return `Offered by ${authorName(agents, offer.by)}. ${when}.`;
}

/** Return whether a text is a new sentence for a deliverable: it has words, and it is not the sentence that stands. */
export function isNewSentence(text: string, standing = ''): boolean {
  const line = text.trim();
  return line !== '' && line !== standing;
}
