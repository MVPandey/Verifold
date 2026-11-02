/**
 * Reopen: the person brings an ended direction's agent back. Its folder, its
 * branch, its verdict, and its posts stay as they are, and only its agent
 * changes the verdict. Its conversation goes on when it can resume, and a new
 * one starts when it cannot. Either way the agent hears why, and which thread.
 */
import { boardLimits, clip, type NewPost } from '../board.ts';
import {
  fail,
  type AgentRecord,
  type Direction,
  type LabState,
  type Thread,
} from './schema.ts';
import type { ThreadStore } from './thread-store.ts';

/** Why the direction cannot reopen now. Null: it can. `ending`: its session still ends. */
export function reopenRefusal(
  direction: Pick<Direction, 'state'>,
  agent: Pick<AgentRecord, 'handle' | 'stopReason' | 'finished'> | undefined,
  ending: boolean,
): string | null {
  if (direction.state === 'open') return 'That direction is open already.';
  if (!agent) return 'That direction has no agent to bring back.';
  return ending || (agent.stopReason === 'closed' && !agent.finished)
    ? `${agent.handle} still saves its last turn. Try again in a moment.`
    : null;
}

/** The agent back at work. It keeps its session, so its conversation can go on. */
function reopenedAgent(agent: AgentRecord): AgentRecord {
  return {
    ...agent,
    stoppedAt: null,
    stopReason: null,
    finished: false,
    idleStreak: 0,
    restarts: [],
  };
}

/** What the board says, and what the agent hears. */
function reopenWords(
  direction: Pick<Direction, 'title'>,
  agent: Pick<AgentRecord, 'handle'>,
  thread: Pick<Thread, 'id'> | undefined,
): { readonly note: string; readonly heard: string } {
  return {
    note: `The person reopened ${JSON.stringify(direction.title)} for ${agent.handle}. Its folder and its record stay.`,
    heard: `The person reopened your direction. Your folder and your record stay, and so does your verdict until you change it.${thread ? ` Read ${thread.id} first.` : ''}`,
  };
}

/** What the lab gives a reopen. */
export interface ReopenHost {
  readonly threaded: boolean;
  state(): LabState;
  agent(id: string): AgentRecord | undefined;
  /** Its session still ends. */
  ending(agent: AgentRecord): boolean;
  /** Refuses when the lab cannot start this agent: it has no room for one more open direction, or it is paused. */
  room(): void;
  save(next: LabState): Promise<void>;
  change(
    agent: string,
    next: (agent: AgentRecord) => AgentRecord,
  ): Promise<void>;
  readonly threads: Pick<ThreadStore, 'get' | 'follow'>;
  add(fields: NewPost): Promise<unknown>;
  /** The agent hears a line in the person's name, also in a new conversation, and starts when a slot is free. */
  wake(agent: string, text: string): void;
}

/**
 * The person brings back an ended direction's agent, inside the limit of open
 * directions. The agents' allowance of starts does not count: this is the
 * person's act. The agent takes a free slot like any other. `thread`: the
 * thread that it comes back to: it follows that thread. Runs in the lab's
 * queue. A save of the agent or the direction that fails changes nothing. Past
 * those saves nothing can strand the agent: it hears why in any case. Refuses,
 * with a reason that the person can read.
 */
export async function reopenDirection(
  host: ReopenHost,
  id: unknown,
  thread: unknown,
): Promise<void> {
  const state = host.state();
  if (!host.threaded) fail('A lab from before threads has no Reopen.');
  const direction =
    state.directions.find((entry) => entry.id === id) ??
    fail('Choose a direction of the lab.');
  const named =
    thread === undefined
      ? undefined
      : (host.threads.get(thread) ?? fail('This thread is gone.'));
  const agent = host.agent(direction.agent);
  const refusal = reopenRefusal(
    direction,
    agent,
    agent ? host.ending(agent) : false,
  );
  if (refusal || !agent) fail(refusal ?? 'Choose a direction of the lab.');
  host.room();
  await host.change(agent.id, reopenedAgent);
  await host
    .save({
      ...state,
      directions: state.directions.map((entry) =>
        entry === direction
          ? { ...entry, state: 'open', stoppedAt: null }
          : entry,
      ),
    })
    .catch(async (error: unknown) => {
      await host.change(agent.id, () => agent).catch(() => {});
      throw error;
    });
  // A failed save comes again with the thread's next change.
  if (named) await host.threads.follow(agent.id, named.id).catch(() => {});
  const { note, heard } = reopenWords(direction, agent, named);
  // A full board refuses the note. The agent hears it all the same.
  await host
    .add({
      author: 'verifold',
      kind: 'status',
      direction: direction.id,
      ...(named ? { thread: named.id } : {}),
      text: clip(note, boardLimits.text),
      mentions: [],
      artifacts: [],
    })
    .catch(() => {});
  host.wake(agent.id, heard);
}
