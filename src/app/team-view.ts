import type { Agent, Direction, Lab } from '../protocol/api.ts';
import {
  agentRows,
  agentsWord,
  type AgentRow,
  type Chip,
} from './agent-rows.ts';
import { roleName, since } from './format.ts';
import type { ViewMode } from './view-mode.ts';

/** Past this many agents, the home folds them into teams. */
const rowsUpTo = 6;

/** A wait, or a silence after a run, counts as trouble from this age. */
const troubleMinutes = 30;

/** What a row can say is wrong. */
export type TroubleKind = 'crashed' | 'wait' | 'silent' | 'disputed' | 'helper';

/** One agent in trouble. */
export interface Trouble {
  readonly agent: Agent;
  readonly kind: TroubleKind;
  /** What is wrong, after the agent's name. */
  readonly line: string;
  readonly chip: Chip;
}

const directionAgents = (lab: Pick<Lab, 'agents'>): readonly Agent[] =>
  lab.agents.filter((agent) => agent.direction !== null);

/** The home folds its rows. A checker comes and goes, so it does not count. */
export function foldsTeams(lab: Pick<Lab, 'agents'>): boolean {
  return directionAgents(lab).length > rowsUpTo;
}

const old = (at: string, now: number): boolean =>
  now - Date.parse(at) >= troubleMinutes * 60_000;

/** The agent's oldest wait past the threshold, on an agent or on the person. */
function waitTrouble(
  agent: Agent,
  lab: Lab,
  mode: ViewMode,
  now: number,
): Trouble | null {
  const wait = lab.waits?.find(
    (entry) => entry.waiter === agent.id && old(entry.since, now),
  );
  if (wait) {
    const on = wait.onHandle ? roleName(wait.onHandle) : 'you';
    const plain = lab.threads?.find(({ id }) => id === wait.thread)?.plainTitle;
    return {
      agent,
      kind: 'wait',
      line:
        mode === 'technical'
          ? `waits on ${on} (${wait.post}): ${wait.subject}`
          : `waits on ${on}: ${plain ?? wait.subject}`,
      chip: { label: since(wait.since, now), tone: 'wait' },
    };
  }
  const call = lab.needsYou.find(
    (entry) =>
      entry.askers.some((asker) => asker.agent === agent.id) &&
      old(entry.at, now),
  );
  return call
    ? {
        agent,
        kind: 'wait',
        line:
          mode === 'technical'
            ? `waits on you: ${call.id}`
            : 'waits on your decision.',
        chip: { label: since(call.at, now), tone: 'wait' },
      }
    : null;
}

/**
 * Silence after a run ended. A long run with no post is not silence: the
 * server's `runState` covers all of the agent's runs, also those that a
 * snapshot's `runs` left out. Only an agent that could speak counts.
 */
function silentTrouble(
  agent: Agent,
  lab: Lab,
  mode: ViewMode,
  now: number,
): Trouble | null {
  const ended = agent.runState?.ended;
  if (
    !ended ||
    agent.runState?.active ||
    lab.paused ||
    !['working', 'idle', 'starting'].includes(agent.status) ||
    !old(ended.at, now) ||
    [agent.line?.at, agent.lastPostAt].some(
      (at) => at && Date.parse(at) >= Date.parse(ended.at),
    )
  )
    return null;
  return {
    agent,
    kind: 'silent',
    line:
      mode === 'technical'
        ? `no status or post since ${ended.run} ended.`
        : 'has said nothing since its run ended.',
    chip: { label: since(ended.at, now), tone: 'wait' },
  };
}

function disputedTrouble(
  agent: Agent,
  direction: Direction | undefined,
  lab: Lab,
  mode: ViewMode,
): Trouble | null {
  if (!direction?.disputed) return null;
  const objection = lab.waits?.find(
    (wait) => wait.on === agent.id && wait.reason === 'objection',
  );
  const from = objection
    ? objection.waiterHandle
      ? roleName(objection.waiterHandle)
      : 'you'
    : null;
  return {
    agent,
    kind: 'disputed',
    line:
      mode === 'technical' && objection
        ? `${objection.post} objects to a post of ${direction.id}.`
        : from
          ? `has a post under objection from ${from}.`
          : 'has a disputed post.',
    chip: { label: 'Disputed', tone: 'open' },
  };
}

function helperTrouble(agent: Agent, mode: ViewMode): Trouble | null {
  const lost = agent.helpers?.find((helper) => helper.state === 'lost');
  return lost
    ? {
        agent,
        kind: 'helper',
        line:
          mode === 'technical'
            ? `helper ${lost.label} stopped with no result: ${lost.title}`
            : `lost a helper with no result: ${lost.title}`,
        chip: { label: 'Helper lost', tone: 'wait' },
      }
    : null;
}

/**
 * What is wrong with an agent that works, or null: a stop by itself, a wait
 * past the threshold, a silence after its run, a disputed post, or a lost
 * helper. An agent that ended has no trouble, and a row says that it ended.
 */
function troubleOf(
  agent: Agent,
  lab: Lab,
  mode: ViewMode,
  now: number,
): Trouble | null {
  if (agent.status === 'crashed')
    return {
      agent,
      kind: 'crashed',
      line:
        mode === 'technical'
          ? 'stopped by itself too often.'
          : 'stopped by itself. Open it to start it again.',
      chip: { label: 'Stopped', tone: 'wait' },
    };
  if (agent.status === 'closed' || agent.status === 'stopped') return null;
  const direction = lab.directions.find(
    (entry) => entry.id === agent.direction,
  );
  return (
    waitTrouble(agent, lab, mode, now) ??
    silentTrouble(agent, lab, mode, now) ??
    disputedTrouble(agent, direction, lab, mode) ??
    helperTrouble(agent, mode)
  );
}

/** Each agent in trouble, once. */
export function troubles(
  lab: Lab,
  mode: ViewMode,
  now: number,
): readonly Trouble[] {
  return directionAgents(lab).flatMap(
    (agent) => troubleOf(agent, lab, mode, now) ?? [],
  );
}

/** One team on the home. */
export interface TeamRow {
  readonly name: string;
  /** "Agents 4, 8 and 12". */
  readonly members: string;
  readonly chip: Chip;
  readonly line: string;
  /** Who has helpers, such as "Agent 19: 3 helpers". Null: no one. */
  readonly helpers: string | null;
  /** Its agents, as the rows open. */
  readonly rows: readonly AgentRow[];
}

const noTeam = 'No team';
const checkers = 'Checkers';

/** The chip of a team: the worst thing that its members show, or what they do. */
function teamChip(
  rows: readonly AgentRow[],
  trouble: readonly Trouble[],
): Chip {
  const count = (kind: TroubleKind): number =>
    trouble.filter((entry) => entry.kind === kind).length;
  const waits = count('wait');
  const onYou = rows.some((row) => row.chip.tone === 'need');
  if (onYou) return { label: 'Waits on you', tone: 'need' };
  if (count('disputed'))
    return { label: `${count('disputed')} disputed`, tone: 'open' };
  if (waits) return { label: `${waits} waiting`, tone: 'wait' };
  if (count('silent'))
    return { label: `${count('silent')} silent`, tone: 'wait' };
  if (count('helper'))
    return { label: `${count('helper')} lost a helper`, tone: 'wait' };
  if (count('crashed'))
    return { label: `${count('crashed')} stopped`, tone: 'wait' };
  if (rows.some((row) => row.chip.label === 'Running'))
    return { label: 'Running', tone: 'run' };
  if (rows.some((row) => row.chip.tone !== 'done'))
    return { label: 'Working', tone: 'run' };
  return rows.every((row) => row.agent.status === 'closed')
    ? { label: 'Closed', tone: 'done' }
    : { label: 'Ended', tone: 'done' };
}

/** The newest line that a member gave, or the first row's line. */
function teamLine(rows: readonly AgentRow[]): string {
  const newest = rows
    .filter((row) => row.statusAt !== null)
    .sort(
      (a, b) => Date.parse(b.statusAt ?? '') - Date.parse(a.statusAt ?? ''),
    )[0];
  const row = newest ?? rows[0];
  return row ? `${roleName(row.agent.handle)}: ${row.line}` : '';
}

/** What the members' helpers do. */
function teamHelpers(rows: readonly AgentRow[]): string | null {
  const lines = rows.flatMap((row) =>
    row.helpers ? [`${roleName(row.agent.handle)}: ${row.helpers}`] : [],
  );
  return lines.length ? `${lines.join('. ')}.` : null;
}

const teamRank: Readonly<Record<Chip['tone'], number>> = {
  need: 0,
  open: 1,
  wait: 2,
  run: 3,
  ok: 3,
  done: 4,
};

/** The agents by team, troubled teams first, ended teams last. A direction names its team. Checkers fold together. */
export function teamRows(
  lab: Lab,
  mode: ViewMode,
  now: number,
): readonly TeamRow[] {
  const trouble = troubles(lab, mode, now);
  const groups = new Map<string, AgentRow[]>();
  for (const row of agentRows(lab, now)) {
    const name = row.direction ? (row.direction.team ?? noTeam) : checkers;
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  return [...groups]
    .map(([name, rows]): TeamRow => {
      const ids = new Set(rows.map((row) => row.agent.id));
      return {
        name,
        members: agentsWord(
          rows
            .map((row) => row.agent.handle)
            .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
        ),
        chip: teamChip(
          rows,
          trouble.filter((entry) => ids.has(entry.agent.id)),
        ),
        line: teamLine(rows),
        helpers: teamHelpers(rows),
        rows,
      };
    })
    .sort((a, b) => teamRank[a.chip.tone] - teamRank[b.chip.tone]);
}
