import { GUEST, PERSON } from '../api/types.ts';
import type { AgentActivity, AgentLeft, AgentView } from '../api/types.ts';
import { dayClock, duration, minutesBetween, money, tokens } from './format.ts';
import { retryLine } from './limits.ts';

/** The dot before an agent's state. */
export type Dot = 'live' | 'wait' | 'idle' | 'stop';

export interface StateLine {
  readonly text: string;
  readonly dot: Dot;
}

/**
 * Who an author is to the page: a member, which shows with its own picture, the person, or a blind rerun, which
 * has no name and no picture in a thread. A blind rerun is a checker that Verifold started for a rerun request, in
 * a lab from before agents took reruns. Its posts keep that label.
 */
export type Author =
  | { readonly kind: 'member'; readonly name: string; readonly view: AgentView }
  | { readonly kind: 'person' | 'rerun'; readonly name: string };

/** Return the lab's members: its agents without the blind checkers of a lab from before agents took reruns. */
export function members(agents: readonly AgentView[]): readonly AgentView[] {
  return agents.filter((view) => view.agent.checks === null);
}

/** Return the members that are in the lab now: the ones that have not left. */
export function present(agents: readonly AgentView[]): readonly AgentView[] {
  return members(agents).filter((view) => view.left === null);
}

/**
 * Return the members that count as in the lab. An invited agent counts from its first post, because until then
 * nobody knows whether it came.
 */
export function counted(agents: readonly AgentView[]): readonly AgentView[] {
  return present(agents).filter((view) => view.agent.harness !== GUEST || view.posts > 0);
}

/** Return the state of a member that left: who caused it, and the reason when it has one. */
export function leftLine(left: AgentLeft): StateLine {
  // The words of the coordinator's request never follow "removed by you": its reason is in the conversation.
  const removed = left.through
    ? 'Left, removed by the coordinator with the power “Add or remove agents”'
    : left.request
      ? 'Left, removed by you at the coordinator’s request'
      : 'Left, removed by you';
  const how = left.by === PERSON ? removed : 'Left by its own choice';
  return { text: left.reason ? `${how}: ${left.reason}` : how, dot: 'stop' };
}

/** Return who an author is. An author that the lab does not list as a member shows as a blind rerun. */
export function author(agents: readonly AgentView[], authorId: string): Author {
  if (authorId === PERSON) return { kind: 'person', name: 'You' };
  const view = members(agents).find((one) => one.agent.id === authorId);
  if (view) return { kind: 'member', name: view.agent.name, view };
  return { kind: 'rerun', name: authorName(agents, authorId) };
}

/** Return an author's own name: the agent's name, such as "Checker 12" for a blind checker, or "You". */
export function ownName(agents: readonly AgentView[], authorId: string): string {
  if (authorId === PERSON) return 'You';
  return agents.find((view) => view.agent.id === authorId)?.agent.name ?? authorId;
}

/**
 * Return the name of an author in a thread: its own name, or "Blind rerun" for a blind checker, which has no
 * name there.
 */
export function authorName(agents: readonly AgentView[], authorId: string): string {
  const checker = agents.some((view) => view.agent.id === authorId && view.agent.checks !== null);
  return checker ? 'Blind rerun' : ownName(agents, authorId);
}

/** Return how a sentence names an author, such as "objected to the blind rerun’s check". */
export function called(agents: readonly AgentView[], authorId: string): string {
  if (authorId === PERSON) return 'you';
  const name = authorName(agents, authorId);
  return name === 'Blind rerun' ? 'the blind rerun' : name;
}

/**
 * Return what a member does, in one line. For a member that is in no turn, the line says what wakes it: its alarm
 * with the time, its alarm for a quiet board, or only a post. `resting` says that the lab is out of time or closed,
 * where no alarm rings.
 */
export function memberLine(view: AgentView, resting: boolean, now: Date): StateLine {
  if (view.left) return leftLine(view.left);
  if (view.activity.state !== 'idle' || resting) return stateLine(view.activity, now);
  if (view.alarm?.quiet) {
    const quiet = duration(Math.round(view.alarm.minutes));
    return { text: `Waits for its alarm: rings after ${quiet} with no new post.`, dot: 'idle' };
  }
  if (view.alarm?.rings_at) {
    return { text: `Waits for its alarm at ${dayClock(view.alarm.rings_at, now)}.`, dot: 'idle' };
  }
  if (!view.turn_ended_at) return stateLine(view.activity, now);
  const minutes = minutesBetween(view.turn_ended_at, now);
  const ended = minutes > 0 ? `${duration(minutes)} ago` : 'just now';
  return {
    text: `Its last turn ended ${ended}, and no alarm is set. A post for it wakes it.`,
    dot: 'idle',
  };
}

/** Return what an agent is doing, in one line, with how long it has done it. */
export function stateLine(activity: AgentActivity, now: Date): StateLine {
  const minutes = activity.at ? minutesBetween(activity.at, now) : 0;
  const since = minutes > 0 ? `, ${duration(minutes)}` : '';
  switch (activity.state) {
    case 'working':
      return { text: `${activity.detail || 'Working'}${since}`, dot: 'live' };
    case 'waiting':
      // An agent that waits for more time or for its own process is in no turn. The line is the server's own.
      if (activity.waits_for === 'time') {
        return { text: activity.detail || 'The lab is out of time.', dot: 'idle' };
      }
      if (activity.waits_for === 'limit') {
        return { text: activity.detail || 'The lab reached a limit.', dot: 'idle' };
      }
      if (activity.waits_for === 'retry' && activity.retry) {
        return { text: retryLine(activity.retry, now), dot: 'stop' };
      }
      if (activity.waits_for === 'process') {
        return {
          text: activity.detail || 'Waits for a process that it left running.',
          dot: 'idle',
        };
      }
      return { text: `${activity.detail || 'Waiting for you'}${since}`, dot: 'wait' };
    case 'idle':
      return { text: `Idle${since}`, dot: 'idle' };
    case 'starting':
      return { text: 'Starting', dot: 'idle' };
    case 'stopped':
      // The server says why an agent with no loop is stopped, such as a harness that this computer lacks.
      return { text: activity.detail || 'Stopped', dot: 'stop' };
    case 'invited':
      return { text: 'Invited, not joined yet', dot: 'idle' };
    case 'void':
      return { text: 'Invitation is void. Invite again.', dot: 'stop' };
    case 'listening':
      return { text: `Waits for a post${since}`, dot: 'idle' };
    case 'here':
      // Without a time, the agent joined before this server started, and nobody saw its last call.
      if (!activity.at) return { text: 'Joined', dot: 'idle' };
      return {
        text: `Last board call ${minutes > 0 ? `${duration(minutes)} ago` : 'just now'}`,
        dot: 'idle',
      };
  }
}

/** Return what an agent has cost: its price when the harness gives one, or else its tokens. */
export function costLine(view: AgentView): string {
  if (view.agent.harness === GUEST) return 'Runs by itself, so Verifold sees no turns and no cost.';
  if (view.turns === 0) return view.turns_started > 0 ? 'In its first turn' : 'No turns yet';
  const turns = `${view.turns} ${view.turns === 1 ? 'turn' : 'turns'}`;
  if (view.cost_usd !== null) return `${money(view.cost_usd)} over ${turns}`;
  const { input_tokens: input, output_tokens: output } = view.usage;
  return `${tokens(input)} tokens in, ${tokens(output)} out over ${turns}. Cost not reported by the harness.`;
}

/**
 * Return what the lab has cost so far, such as "$0.37, and 463k tokens with cost not reported by the harness".
 * Only a cost that a harness reported counts as money: a harness that reports tokens and no cost adds tokens,
 * and never $0.
 */
export function labTotal(agents: readonly AgentView[]): string {
  const priced = agents.filter((view) => view.cost_usd !== null);
  const usd = priced.reduce((sum, view) => sum + (view.cost_usd ?? 0), 0);
  const unpriced = agents
    .filter((view) => view.cost_usd === null)
    .reduce((sum, view) => sum + view.usage.input_tokens + view.usage.output_tokens, 0);
  if (unpriced === 0) return priced.length > 0 ? money(usd) : 'No cost reported yet';
  const rest = `${tokens(unpriced)} tokens with cost not reported by the harness`;
  return priced.length > 0 ? `${money(usd)}, and ${rest}` : rest;
}

/**
 * Return what the blind reruns of a lab from before agents took reruns cost, such as "Earlier blind reruns: $0.12.
 * The lab total holds it.", or `null` for a lab without them. Their checkers have no row in the member list, and
 * the lab total still holds their cost, so this line makes the rows and the total agree.
 */
export function earlierReruns(agents: readonly AgentView[]): string | null {
  const checkers = agents.filter((view) => view.agent.checks !== null);
  if (checkers.length === 0) return null;
  return `Earlier blind reruns: ${labTotal(checkers)}. The lab total holds it.`;
}
