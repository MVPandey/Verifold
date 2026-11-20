import { PERSON } from '../api/types.ts';
import type { AgentView, HarnessOption, MoveView, SeatChoice, SpareSeats } from '../api/types.ts';
import { authorName } from './agents.ts';
import { clock, tokens } from './format.ts';

/**
 * One move of the coordinator as the log shows it. `what` is the app's own sentence, which holds no text of an
 * agent and no name. `seat` is the name of the seat that the move names, `theirs` is the agent's text that the move
 * holds, such as the question of a round, and `why` is the coordinator's one line of why. The page shows each of
 * them apart from the app's sentence.
 */
export interface MoveWords {
  readonly what: string;
  readonly seat: string | null;
  readonly theirs: string;
  readonly why: string;
}

/** The most moves that the lab page lists beside the chat. The panel for the coordinator lists all of them. */
export const MOVES_IN_SIGHT = 3;

/** Return the words of one move of the coordinator. A name of an agent is the app's, from the lab's agents. */
export function moveWords(move: MoveView, agents: readonly AgentView[]): MoveWords {
  const { post } = move.post;
  const yours = move.yes_by === PERSON ? ', with your yes' : '';
  const plain = (what: string, theirs = ''): MoveWords => ({
    what: `${what}${yours}`,
    seat: move.agent ? authorName(agents, move.agent) : null,
    theirs,
    why: move.why,
  });
  if (post.kind === 'round')
    return plain(`Opened a ${String(post.minutes)}-minute round`, post.text);
  if (post.kind === 'reading') return plain('Posted a new reading', post.text);
  if (post.kind !== 'request') return plain('Made a move');
  const asked = post.move;
  switch (asked.type) {
    case 'time':
      return plain(
        `Gave the lab ${String(move.post.decision?.minutes ?? asked.minutes)} more minutes`,
      );
    case 'permission':
      return plain('Answered a permission request');
    case 'add_agent':
      return plain(asked.seat.fresh ? 'Added a seat with a fresh view' : 'Added a seat');
    case 'remove_agent':
      return plain('Removed a seat');
    case 'setting':
      return plain('Changed a setting of the lab');
    case 'question':
      return plain('Revised the question', asked.question);
    case 'pause':
      return plain(asked.until ? `Paused a seat until ${clock(asked.until)}` : 'Paused a seat');
    case 'resume':
      return plain('Resumed a seat');
    case 'cap':
      if (!asked.tokens_per_hour) return plain('Took back its limit of tokens per hour');
      return plain(
        asked.agent
          ? `Limited a seat to ${tokens(asked.tokens_per_hour)} tokens an hour`
          : `Limited the lab to ${tokens(asked.tokens_per_hour)} tokens an hour`,
      );
  }
}

/** Return the line of the grant that stands, or of no grant, for the panel for the coordinator. */
export function grantLine(grant: SpareSeats | null | undefined, name: string): string {
  if (!grant) return `${name} adds no agent by itself. Each add waits for your yes.`;
  const seats = (count: number): string => `${String(count)} ${count === 1 ? 'seat' : 'seats'}`;
  if (grant.left === 0) return `${name} used the ${seats(grant.of)} that you granted.`;
  return `${name} may add ${seats(grant.left)} more by itself, of ${String(grant.of)} that you granted.`;
}

/** Return one kind of seat of a grant in the app's words, with the harness's own names where it has them. */
export function kindLine(kind: SeatChoice, harnesses: readonly HarnessOption[]): string {
  const harness = harnesses.find((option) => option.name === kind.harness);
  const offer = harness?.offer ?? null;
  const named = (
    value: string | null,
    values: readonly { value: string; name: string }[] | undefined,
  ): string =>
    value === null ? 'default' : (values?.find((item) => item.value === value)?.name ?? value);
  return [
    harness?.title ?? kind.harness,
    `model ${named(kind.model, offer?.models)}`,
    `effort ${named(kind.effort, offer?.efforts)}`,
    `mode ${named(kind.mode, offer?.modes)}`,
  ].join(' · ');
}

/** Return whether two kinds of seat are the same, as the server compares them. */
export function sameKind(one: SeatChoice, other: SeatChoice): boolean {
  return (
    one.harness === other.harness &&
    one.model === other.model &&
    one.effort === other.effort &&
    one.mode === other.mode
  );
}
