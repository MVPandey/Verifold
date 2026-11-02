import type { Agent, Direction, Lab, Run } from '../protocol/api.ts';
import { directionLine, roleOf } from '../ui/lab-lines.ts';
import { andList } from '../ui/call-words.ts';
import { clock, roleName } from './format.ts';
import { helperLine } from './helpers.ts';
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
  /** What the agent does and why, in its own words when it gave them. */
  readonly line: string;
  /** What Simple shows in place of `line` for an agent that ended, from the records. */
  readonly ended: string | null;
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

/** How a direction's verdict reads on the line of its closed agent. */
const verdictEnd: Partial<Record<Direction['verdict'], string>> = {
  'ruled-out': ' after its test failed',
  'holds-up': ' after its test held up',
};

/** An ended direction in plain words, from the records. */
function endedLine(agent: Agent, direction: Direction | null): string | null {
  if (!direction || direction.state === 'open' || agent.line) return null;
  const at = direction.stoppedAt ?? agent.live.since;
  const when = at ? ` at ${clock(at)}` : '';
  return `${direction.state === 'closed' ? 'Closed' : 'Stopped'}${when}${verdictEnd[direction.verdict] ?? ''}. Its code and outputs stay for the others.`;
}

/** The agent's newest run that is not over, from the records. */
function runLine(runs: readonly Run[]): string | null {
  const run = runs.findLast(
    (entry) => entry.status === 'running' || entry.status === 'queued',
  );
  if (!run) return null;
  return run.startedAt
    ? `${run.id} started ${clock(run.startedAt)}.`
    : `${run.id} queued ${clock(run.queuedAt)}.`;
}

function rowOf(agent: Agent, lab: Lab, now: number): AgentRow {
  const direction =
    lab.directions.find((entry) => entry.id === agent.direction) ?? null;
  const runs = lab.runs.filter((run) => run.agent === agent.id);
  const line = agent.line
    ? `${sentence(agent.line.doing)} ${sentence(agent.line.why)}`
    : directionLine(direction?.evidence?.text ?? null, agent.live, now).text;
  return {
    agent,
    direction,
    chip: chipOf(agent, runs, lab),
    line,
    ended: endedLine(agent, direction),
    next: agent.line?.next ?? null,
    statusAt: agent.line?.at ?? null,
    wait: waitLine(lab, agent.id),
    helpers: helperLine(agent.helpers ?? []),
    run: runLine(runs),
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

/** Names of agents by number: "Agent 1", "Agents 2, 3 and 4". */
export function agentsWord(handles: readonly string[]): string {
  const numbers = handles.map((handle) => roleOf(handle)?.number ?? handle);
  return `Agent${numbers.length > 1 ? 's' : ''} ${andList(numbers)}`;
}

/** How many names a reach line lists. Past that, it counts. */
const namedAgents = 5;

/** Who reads the person's post to the lab, and when. Every open agent reads the plan thread after its current step. */
export function reachLine(lab: Lab): string {
  const handles = (state: Direction['state']): readonly string[] =>
    lab.directions
      .filter((direction) => direction.state === state)
      .flatMap(
        (direction) =>
          lab.agents.find((agent) => agent.id === direction.agent)?.handle ??
          [],
      );
  const open = handles('open');
  const ended = [...handles('closed'), ...handles('stopped')];
  const readers = !open.length
    ? 'No agent works now, so no agent reads this.'
    : lab.paused
      ? `${agentsWord(open)} read${open.length > 1 ? '' : 's'} this after the lab resumes.`
      : open.length > namedAgents
        ? `${open.length} agents read this after their current steps.`
        : `${agentsWord(open)} read${open.length > 1 ? '' : 's'} this after ${open.length > 1 ? 'their current steps' : 'its current step'}.`;
  if (!ended.length) return readers;
  const others =
    ended.length > namedAgents
      ? `${ended.length} agents ended.`
      : `${agentsWord(ended)} ended.`;
  return `${readers} ${others}`;
}
