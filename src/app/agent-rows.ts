import type { Agent, Direction, Lab, Reading, Run } from '../protocol/api.ts';
import {
  directionLine,
  roleOf,
  shownVerdict,
  verdictLabels,
} from '../ui/lab-lines.ts';
import { andList } from '../ui/call-words.ts';
import {
  agentDetail,
  harnessLabel,
  roleName,
  shortTime,
  since,
} from './format.ts';
import { helperLine } from './helpers.ts';
import type { ViewMode } from './view-mode.ts';
import { waitLine } from './waits.ts';

export type Tone = 'run' | 'wait' | 'need' | 'done' | 'ok' | 'open';

/** A state chip: its words and its color. */
export interface Chip {
  readonly label: string;
  readonly tone: Tone;
}

/** One row of "Who is doing what". */
export interface AgentRow {
  readonly agent: Agent;
  readonly direction: Direction | null;
  readonly chip: Chip;
  /** What the agent does and why, in its own words when it gave them. An agent that ended has the words of the record, in both views. */
  readonly line: string;
  /** The words of an ended direction's evidence, for the Technical view. */
  readonly evidence: string | null;
  /** What the agent says comes next. */
  readonly next: string | null;
  /** When the agent gave its line. */
  readonly statusAt: string | null;
  /** Who it waits on. */
  readonly wait: string | null;
  readonly helpers: string | null;
  /** Its run from the records, with its ID, for the Technical view. */
  readonly run: string | null;
}

const sentence = (text: string): string =>
  /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;

function chipOf(agent: Agent, runs: readonly Run[], lab: Lab): Chip {
  const { live } = agent;
  if (agent.status === 'closed') return { label: 'Closed', tone: 'done' };
  if (live.state === 'ended') return { label: live.text, tone: 'done' };
  if (
    lab.needsYou.some((call) =>
      call.askers.some((asker) => asker.agent === agent.id),
    ) ||
    lab.waits?.some((wait) => wait.waiter === agent.id && wait.on === 'person')
  )
    return { label: 'Waits on you', tone: 'need' };
  if (runs.some((run) => run.status === 'running'))
    return { label: 'Running', tone: 'run' };
  const queued = runs.find((run) => run.status === 'queued');
  if (queued) {
    const test = queued.where === 'local' ? 'Test queued' : 'GPU test queued';
    return {
      label: live.state === 'working' ? `Working · ${test}` : test,
      tone: 'wait',
    };
  }
  const wait = lab.waits?.find((entry) => entry.waiter === agent.id);
  if (wait?.onHandle)
    return { label: `Waits on ${roleName(wait.onHandle)}`, tone: 'wait' };
  if (live.state === 'working') return { label: 'Working', tone: 'run' };
  return { label: live.text, tone: live.state === 'waiting' ? 'wait' : 'done' };
}

/** Running agents first, then those that wait, those that wait on the person, and ended agents last. */
const toneRank: Readonly<Record<Tone, number>> = {
  run: 0,
  wait: 1,
  need: 2,
  open: 3,
  ok: 3,
  done: 4,
};

/**
 * An ended direction in the words of the record: its end, its time, and its
 * verdict's own word. Its folder and branch stay when it ends. Null: it did
 * not end, or it is a checker's row.
 */
function endedLine(
  agent: Agent,
  direction: Direction | null,
  now: number,
): string | null {
  if (!direction || direction.state === 'open') return null;
  const at = direction.stoppedAt ?? agent.live.since;
  return [
    `${direction.state === 'closed' ? 'Closed' : 'Stopped'}${at ? ` at ${shortTime(at, now)}` : ''}.`,
    ...(direction.verdict === 'open'
      ? []
      : [`${verdictLabels[shownVerdict(direction)]}.`]),
    'Its folder stays.',
  ].join(' ');
}

/** The agent's newest run that is not over, from the records. */
function runLine(runs: readonly Run[], now: number): string | null {
  const run = runs.findLast(
    (entry) => entry.status === 'running' || entry.status === 'queued',
  );
  if (!run) return null;
  return run.startedAt
    ? `${run.id} started ${shortTime(run.startedAt, now)}.`
    : `${run.id} queued ${shortTime(run.queuedAt, now)}.`;
}

function rowOf(agent: Agent, lab: Lab, now: number): AgentRow {
  const direction =
    lab.directions.find((entry) => entry.id === agent.direction) ?? null;
  const runs = lab.runs.filter((run) => run.agent === agent.id);
  const ended = endedLine(agent, direction, now);
  const status = ended ? null : (agent.line ?? null);
  return {
    agent,
    direction,
    chip: chipOf(agent, runs, lab),
    line:
      ended ??
      (status
        ? `${sentence(status.doing)} ${sentence(status.why)}`
        : directionLine(direction?.evidence?.text ?? null, agent.live, now)
            .text),
    evidence: ended ? (direction?.evidence?.text ?? null) : null,
    next: status?.next ?? null,
    statusAt: status?.at ?? null,
    wait: waitLine(lab, agent.id),
    helpers: helperLine(agent.helpers ?? []),
    run: runLine(runs, now),
  };
}

/**
 * The rows of "Who is doing what": each direction's agent, and each checker
 * that has not ended, in the order of `toneRank`. A checker that ended leaves
 * the list, and its check shows on its post.
 */
export function agentRows(lab: Lab, now: number): readonly AgentRow[] {
  return lab.agents
    .filter((agent) => agent.direction !== null || agent.live.state !== 'ended')
    .map((agent) => rowOf(agent, lab, now))
    .sort((a, b) => toneRank[a.chip.tone] - toneRank[b.chip.tone]);
}

/** What follows a row's name: its job and harness, and in Technical its direction's ID. */
export function rowDetail(
  row: Pick<AgentRow, 'agent' | 'direction'>,
  mode: ViewMode,
): string | null {
  const { agent, direction } = row;
  return mode === 'technical' && direction
    ? `${agent.job ? `${agent.job}, ` : ''}${direction.id} · ${harnessLabel(agent.harness)}`
    : agentDetail(agent);
}

/** The small lines under a row's line, as a view shows them. */
export function rowMore(row: AgentRow, mode: ViewMode): readonly string[] {
  return [
    ...(mode === 'technical'
      ? [
          ...(row.evidence ? [row.evidence] : []),
          ...(row.next ? [`Next: ${row.next}`] : []),
          ...(row.run ? [row.run] : []),
        ]
      : []),
    ...(row.wait ? [row.wait] : []),
    ...(row.helpers ? [row.helpers] : []),
  ];
}

/** The age of an agent's line. Null: it gave none. */
export function rowAge(row: AgentRow, now: number): string | null {
  return row.statusAt
    ? `${shortTime(row.statusAt, now)}, ${since(row.statusAt, now)} ago`
    : null;
}

/** The reading line, and how long ago the last paper came. */
export function readingWords(
  reading: Reading,
  now: number,
): { readonly line: string; readonly age: string | null } {
  const { papers, lastPaperAt } = reading;
  const count = `Reading map: ${papers} ${papers === 1 ? 'paper' : 'papers'}.`;
  return lastPaperAt
    ? {
        line: `${count} Last paper read at ${shortTime(lastPaperAt, now)}.`,
        age: `${since(lastPaperAt, now)} ago`,
      }
    : { line: `${count} No paper read yet.`, age: null };
}

/** Names of agents by number: "Agent 1", "Agents 2, 3 and 4". */
export function agentsWord(handles: readonly string[]): string {
  const numbers = handles.map((handle) => roleOf(handle)?.number ?? handle);
  return `Agent${numbers.length > 1 ? 's' : ''} ${andList(numbers)}`;
}
