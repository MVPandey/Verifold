import type { AgentView, LabView, Need, Wait } from '../api/types.ts';
import { counted, leftLine, memberLine, members, ownName } from './agents.ts';
import { dayClock, duration, minutesBetween } from './format.ts';
import { minutesLeft } from './time.ts';

/** The statuses in their order: who needs the person comes first. */
export const NEEDS: readonly Need[] = [
  'approval',
  'answer',
  'working',
  'waiting',
  'idle',
  'stopped',
  'left',
];

/** The words for each status. */
export const NEED_WORDS: Readonly<Record<Need, string>> = {
  approval: 'Needs your approval',
  answer: 'Needs your answer',
  working: 'Working',
  waiting: 'Waiting on others',
  idle: 'Idle',
  stopped: 'Stopped',
  left: 'Left',
};

/** The ID of the seat's list of what waits for the person. The top bar's count goes to it. */
export const WAITS_ID = 'waits';

/** What an on-call member's row says in place of what wakes it. */
export const ON_CALL = 'On call. An ask or a call that names it wakes it.';

/** Return the heading of a group of `count` agents or asks with one status, such as "Working (6)". */
export function needHeading(need: Need, count: number): string {
  return `${NEED_WORDS[need]} (${count})`;
}

/** The top bar's line about turns, and whether its dot is live. */
export interface TurnLine {
  readonly text: string;
  readonly live: boolean;
}

/**
 * Return how many members are in a turn, such as "3 of 7 agents in a turn, 2 blind reruns", or "No agent in a
 * turn, 7 in the lab". A member that left does not count, and an invited agent counts from its first post. A turn
 * in which the harness waits for the person's answer still runs, so its agent counts as in a turn.
 */
export function turnLine(agents: readonly AgentView[]): TurnLine {
  const all = counted(agents);
  const busy = all.filter((view) => view.in_turn).length;
  const reruns = agents.filter((view) => view.agent.checks !== null && view.in_turn).length;
  const line =
    busy > 0
      ? `${busy} of ${all.length} ${all.length === 1 ? 'agent' : 'agents'} in a turn`
      : `No agent in a turn, ${all.length} in the lab`;
  const text =
    reruns === 0 ? line : `${line}, ${reruns} blind ${reruns === 1 ? 'rerun' : 'reruns'}`;
  return { text, live: busy + reruns > 0 };
}

/** Return the top bar's count of what waits for the person, or `null` when nothing waits. */
export function waitsLine(count: number): string | null {
  if (count === 0) return null;
  return count === 1 ? '1 thing waits for you' : `${count} things wait for you`;
}

/** The members with one status, under their heading. */
export interface NeedGroup {
  readonly need: Need;
  readonly heading: string;
  readonly rows: readonly AgentView[];
}

/** Return the lab's members in groups by status, in the order of who needs the person. An empty group is left out. */
export function needGroups(agents: readonly AgentView[]): readonly NeedGroup[] {
  const all = members(agents);
  return NEEDS.map((need) => {
    const rows = all.filter((view) => view.need === need);
    return { need, heading: needHeading(need, rows.length), rows };
  }).filter((group) => group.rows.length > 0);
}

/**
 * Return the line of a member's row that says what the member does now and, with `title`, the thread where it
 * works. A member that waits for the person says for how long. An on-call member in no turn says what wakes it.
 */
export function whereLine(view: AgentView, lab: LabView, now: Date, title: string | null): string {
  const resting = lab.out_of_time || lab.state === 'closed';
  const wait = lab.waits.find((one) => one.agent === view.agent.id && one.kind === view.need);
  let text: string;
  if (view.left) text = leftLine(view.left).text;
  else if (wait) {
    const minutes = minutesBetween(wait.since, now);
    text = `Waits for your ${wait.kind}${minutes > 0 ? `, ${duration(minutes)}` : ''}`;
  } else if (view.on_call && view.activity.state === 'idle' && !resting)
    return works(ON_CALL, title);
  else text = memberLine(view, resting, now).text;
  return works(`${text.replace(/\.$/, '')}.`, view.left ? null : title);
}

function works(line: string, title: string | null): string {
  return title ? `${line} Works in “${title}”.` : line;
}

/** One row of the seat's list of what waits for the person. */
export interface WaitRow {
  readonly wait: Wait;
  /** The agent's own name. Two checkers can ask at once, so each keeps its name here. */
  readonly name: string;
  /** How long it has waited, such as "12 min". */
  readonly waited: string;
}

/** The waits of one kind, under their heading, with the word on each row's button. */
export interface WaitGroup {
  readonly kind: Wait['kind'];
  readonly heading: string;
  readonly word: 'Decide' | 'Answer';
  readonly rows: readonly WaitRow[];
}

/** Return what waits for the person: the approvals and then the answers, each in the server's order. */
export function waitGroups(lab: LabView, now: Date): readonly WaitGroup[] {
  return (['approval', 'answer'] as const)
    .map((kind) => {
      const rows = lab.waits
        .filter((wait) => wait.kind === kind)
        .map((wait) => ({
          wait,
          name: ownName(lab.agents, wait.agent),
          waited: duration(minutesBetween(wait.since, now)),
        }));
      const word = kind === 'approval' ? ('Decide' as const) : ('Answer' as const);
      return { kind, heading: needHeading(kind, rows.length), word, rows };
    })
    .filter((group) => group.rows.length > 0);
}

/** The band above the wall of a lab where no agent is in a turn. */
export interface Quiet {
  readonly title: string;
  readonly text: string;
  /** How many things wait for the person. */
  readonly waits: number;
  /** How many members have an alarm set. */
  readonly alarms: number;
  /** When the next alarm rings, or what starts a turn without one. */
  readonly next: string;
  /** The time that the lab has left. */
  readonly left: string;
}

/**
 * Return the band of a quiet lab, or `null` while an agent or a blind rerun is in a turn, or while no member is
 * in the lab.
 *
 * In a lab that is out of time or that its agents call done, no alarm rings, so the band says what the person can
 * do and names no time of an alarm.
 */
export function quietBand(lab: LabView, now: Date): Quiet | null {
  const here = counted(lab.agents);
  if (here.length === 0 || lab.agents.some((view) => view.in_turn)) return null;
  const ended = here
    .map((view) => view.turn_ended_at)
    .filter((at) => at !== null)
    .sort((first, second) => new Date(second).getTime() - new Date(first).getTime())[0];
  const minutes = ended ? minutesBetween(ended, now) : 0;
  const since =
    minutes > 0
      ? `No agent has been in a turn for ${duration(minutes)}.`
      : 'No agent is in a turn.';
  const alarms = here.map((view) => view.alarm).filter((alarm) => alarm !== null);
  const counts = { waits: lab.waits.length, alarms: alarms.length };
  if (lab.out_of_time) {
    return {
      title: 'The lab is out of time',
      text: `${since} No agent starts a turn until you give the lab more time.`,
      ...counts,
      next:
        alarms.length > 0 ? 'No alarm rings while the lab is out of time' : 'No turn starts now',
      left: 'None',
    };
  }
  const left = lab.ends_at === null ? 'No limit' : duration(minutesLeft(lab, now));
  if (lab.state === 'closed') {
    return {
      title: 'The lab is quiet',
      text: `${since} The agents say that the lab is done. Your post to the lab opens it again.`,
      ...counts,
      next: alarms.length > 0 ? 'No alarm rings while the lab is done' : 'No alarm is set',
      left,
    };
  }
  const timed = alarms
    .filter((alarm) => !alarm.quiet)
    .map((alarm) => alarm.rings_at)
    .filter((at) => at !== null)
    .sort((first, second) => new Date(first).getTime() - new Date(second).getTime())[0];
  const quiet = alarms
    .filter((alarm) => alarm.quiet)
    .map((alarm) => Math.round(alarm.minutes))
    .sort((first, second) => first - second)[0];
  const after = quiet === undefined ? null : `after ${duration(quiet)} with no new post`;
  const at = timed ? `at ${dayClock(timed, now)}` : null;
  return {
    title: 'The lab is quiet',
    text: `${since} An agent starts a turn when a post is for it, or when its alarm rings.`,
    ...counts,
    // An alarm for a quiet board has no time of day, so the band cannot say which of the two kinds rings first.
    next:
      at && after
        ? `One rings ${at}. One rings ${after}.`
        : at || after
          ? `The next rings ${at ?? after}`
          : 'Only a post starts a turn now',
    left,
  };
}

/** Return how many reviewer seats the lab has and how many of them no agent holds, such as "2 reviewer seats, 1 free." */
export function reviewerLine(lab: LabView): string {
  const seats = lab.reviewer_seats;
  const held = members(lab.agents).filter((view) => view.reviewer && view.left === null).length;
  const follows = lab.reviewer_seats_set === null ? ' The number follows the lab’s size.' : '';
  const count =
    seats === 0
      ? 'No reviewer seats.'
      : `${seats} reviewer ${seats === 1 ? 'seat' : 'seats'}, ${Math.max(0, seats - held)} free.`;
  return `${count}${follows}`;
}
