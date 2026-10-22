import { clip } from '../core/board.ts';
import type { Live, Snapshot } from '../protocol/api.ts';
import { shownVerdict, type ShownVerdict } from '../ui/lab-lines.ts';
import { record } from './http.ts';

/**
 * The lab as the terminal's live view shows it: a small part of the API's
 * snapshot, which the project's owner sends to each attached terminal over
 * the control channel. It holds no token and no path. Its texts are cut, so
 * one message stays far under the channel's line limit.
 */
export interface LabScreen {
  /** The name of the project's folder. */
  readonly project: string;
  /** The desk's address without its token, such as http://127.0.0.1:56933. */
  readonly origin: string;
  /** The package has the new app's build, so the terminal opens a call there. */
  readonly app: boolean;
  readonly money: {
    readonly plansUsd: number;
    readonly gpuUsd: number;
    readonly gpuLimitUsd: number | null;
    /** All projects' GPU spend this month, with the monthly limit. Absent: no monthly limit. */
    readonly month?: { readonly spentUsd: number; readonly limitUsd: number };
  };
  /** The end of the lab's time budget, or null without one. */
  readonly deadline: string | null;
  readonly paused: 'person' | 'deadline' | null;
  /** In the lab's order. A large lab keeps the ones that need a look first. */
  readonly directions: readonly ScreenDirection[];
  /** Directions that `directions` leaves out. */
  readonly more: number;
  /** The oldest call that waits for the person. */
  readonly call: ScreenCall | null;
  /** The calls that wait, in all. */
  readonly calls: number;
}

export interface ScreenDirection {
  readonly id: string;
  readonly title: string;
  readonly shown: ShownVerdict;
  /** Its agent's handle, such as claude-2. Null when the snapshot left the agent out. */
  readonly agent: string | null;
  /** Its agent's live line, which comes from harness events. */
  readonly live: Live | null;
  /** The evidence for its verdict. */
  readonly evidence: string | null;
}

export interface ScreenCall {
  readonly id: string;
  readonly question: string;
  /** The price of the option that the agents advise, or null. */
  readonly usd: number | null;
}

export const screenLimits = {
  /** Directions in a screen. No terminal shows more rows than this. */
  directions: 24,
  /** Characters of a title, a live line, or evidence. */
  text: 160,
  /** Characters of a call's question and of the project's name. */
  question: 240,
};

const ranks: Readonly<Record<ShownVerdict, number>> = {
  disputed: 2,
  open: 3,
  leading: 4,
  holds: 5,
  'ruled-out': 5,
  stopped: 6,
};

/**
 * Which directions a short view keeps first: one that waits for the person,
 * one that works, a disputed one, one not settled, then the settled ones.
 */
export function rank(direction: ScreenDirection): number {
  if (direction.live?.state === 'waiting') return 0;
  if (direction.live?.state === 'working') return 1;
  return ranks[direction.shown];
}

/**
 * The `count` directions of `list` with the best rank, in their own order.
 * Equal ranks keep the earlier direction.
 */
export function firstRanked<T extends ScreenDirection>(
  list: readonly T[],
  count: number,
): readonly T[] {
  const kept = new Set(
    list
      .map((direction, index) => ({ index, rank: rank(direction) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, Math.max(0, count))
      .map(({ index }) => index),
  );
  return list.filter((_, index) => kept.has(index));
}

/** The screen of a snapshot, or null when the project has no lab. */
export function labScreen(
  snapshot: Pick<Snapshot, 'project' | 'lab'>,
  desk: { readonly origin: string; readonly app: boolean },
): LabScreen | null {
  const lab = snapshot.lab;
  if (!lab) return null;
  const agents = new Map(lab.agents.map((agent) => [agent.id, agent]));
  const all = lab.directions.map((direction): ScreenDirection => {
    const agent = agents.get(direction.agent);
    return {
      id: direction.id,
      title: clip(direction.title, screenLimits.text),
      shown: shownVerdict(direction),
      agent: agent?.handle ?? null,
      live: agent
        ? {
            state: agent.live.state,
            text: clip(agent.live.text, screenLimits.text),
            since: agent.live.since,
          }
        : null,
      evidence: direction.evidence
        ? clip(direction.evidence.text, screenLimits.text)
        : null,
    };
  });
  const directions = firstRanked(all, screenLimits.directions);
  const total =
    lab.directionCounts?.total ??
    lab.directions.length + (lab.omitted.directions ?? 0);
  const [first] = lab.needsYou;
  const pick =
    first && first.pick !== null ? first.options[first.pick] : undefined;
  return {
    project: clip(snapshot.project, screenLimits.question),
    origin: desk.origin,
    app: desk.app,
    money: {
      plansUsd: lab.money.plansUsd,
      gpuUsd: lab.money.gpuUsd,
      gpuLimitUsd: lab.money.gpuLimitUsd,
      ...(lab.money.month
        ? {
            month: {
              spentUsd: lab.money.month.spentUsd,
              limitUsd: lab.money.month.limitUsd,
            },
          }
        : {}),
    },
    deadline: lab.budget?.deadline ?? null,
    paused: lab.paused?.reason ?? null,
    directions,
    more: Math.max(0, total - directions.length),
    call: first
      ? {
          id: first.id,
          question: clip(first.question, screenLimits.question),
          usd: pick?.usd ?? null,
        }
      : null,
    calls: lab.needsYou.length + (lab.omitted.needsYou ?? 0),
  };
}

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;
const amount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const time = (value: unknown): value is string | null =>
  value === null || (text(value, 40) && Number.isFinite(Date.parse(value)));
const verdicts: readonly ShownVerdict[] = [
  'holds',
  'disputed',
  'ruled-out',
  'leading',
  'open',
  'stopped',
];
const states: readonly Live['state'][] = [
  'working',
  'waiting',
  'idle',
  'ended',
];
const callId = /^c-[1-9][0-9]{0,5}$/;

function live(value: unknown): Live | null | undefined {
  if (value === null) return null;
  return record(value) &&
    states.includes(value.state as Live['state']) &&
    text(value.text, screenLimits.text * 2) &&
    time(value.since)
    ? {
        state: value.state as Live['state'],
        text: value.text,
        since: value.since,
      }
    : undefined;
}

function direction(value: unknown): ScreenDirection | null {
  if (!record(value)) return null;
  const shown = live(value.live);
  return text(value.id, 100) &&
    text(value.title, screenLimits.text * 2) &&
    verdicts.includes(value.shown as ShownVerdict) &&
    (value.agent === null || text(value.agent, 100)) &&
    shown !== undefined &&
    (value.evidence === null || text(value.evidence, screenLimits.text * 2))
    ? {
        id: value.id,
        title: value.title,
        shown: value.shown as ShownVerdict,
        agent: value.agent,
        live: shown,
        evidence: value.evidence,
      }
    : null;
}

function call(value: unknown): ScreenCall | null | undefined {
  if (value === null) return null;
  return record(value) &&
    text(value.id, 20) &&
    callId.test(value.id) &&
    text(value.question, screenLimits.question * 2) &&
    (value.usd === null || amount(value.usd))
    ? { id: value.id, question: value.question, usd: value.usd }
    : undefined;
}

/** A screen's month across projects: absent, or both amounts. Null: not readable. */
function monthOf(
  value: unknown,
): { readonly spentUsd: number; readonly limitUsd: number } | undefined | null {
  if (value === undefined) return undefined;
  return record(value) && amount(value.spentUsd) && amount(value.limitUsd)
    ? { spentUsd: value.spentUsd, limitUsd: value.limitUsd }
    : null;
}

/**
 * A screen from the control channel, checked field by field. Null for
 * anything else: a terminal shows only what it could read.
 */
export function parseLabScreen(value: unknown): LabScreen | null {
  if (
    !record(value) ||
    !record(value.money) ||
    !text(value.project, screenLimits.question * 2) ||
    !text(value.origin, 100) ||
    !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.origin) ||
    typeof value.app !== 'boolean' ||
    !amount(value.money.plansUsd) ||
    !amount(value.money.gpuUsd) ||
    !(value.money.gpuLimitUsd === null || amount(value.money.gpuLimitUsd)) ||
    !time(value.deadline) ||
    !(
      value.paused === null ||
      value.paused === 'person' ||
      value.paused === 'deadline'
    ) ||
    !Array.isArray(value.directions) ||
    value.directions.length > screenLimits.directions ||
    !count(value.more) ||
    !count(value.calls)
  )
    return null;
  const directions = value.directions.map(direction);
  const first = call(value.call);
  const month = monthOf(value.money.month);
  if (
    first === undefined ||
    month === null ||
    directions.some((entry) => entry === null)
  )
    return null;
  return {
    project: value.project,
    origin: value.origin,
    app: value.app,
    money: {
      plansUsd: value.money.plansUsd,
      gpuUsd: value.money.gpuUsd,
      gpuLimitUsd: value.money.gpuLimitUsd,
      ...(month ? { month } : {}),
    },
    deadline: value.deadline,
    paused: value.paused,
    directions: directions as ScreenDirection[],
    more: value.more,
    call: first,
    calls: value.calls,
  };
}
