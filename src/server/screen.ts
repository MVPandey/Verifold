import type { Live, Snapshot } from '../protocol/api.ts';
import { shownVerdict, type ShownVerdict } from '../ui/lab-lines.ts';

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

/** At most `max` characters, cut at whole code points. */
function cut(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : `${points.slice(0, max - 1).join('')}…`;
}

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
  snapshot: Snapshot,
  desk: { readonly origin: string; readonly app: boolean },
): LabScreen | null {
  const lab = snapshot.lab;
  if (!lab) return null;
  const agents = new Map(lab.agents.map((agent) => [agent.id, agent]));
  const all = lab.directions.map((direction): ScreenDirection => {
    const agent = agents.get(direction.agent);
    return {
      id: direction.id,
      title: cut(direction.title, screenLimits.text),
      shown: shownVerdict(direction),
      agent: agent?.handle ?? null,
      live: agent
        ? {
            state: agent.live.state,
            text: cut(agent.live.text, screenLimits.text),
            since: agent.live.since,
          }
        : null,
      evidence: direction.evidence
        ? cut(direction.evidence.text, screenLimits.text)
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
    project: cut(snapshot.project, screenLimits.question),
    origin: desk.origin,
    app: desk.app,
    money: {
      plansUsd: lab.money.plansUsd,
      gpuUsd: lab.money.gpuUsd,
      gpuLimitUsd: lab.money.gpuLimitUsd,
    },
    deadline: lab.budget?.deadline ?? null,
    paused: lab.paused?.reason ?? null,
    directions,
    more: Math.max(0, total - directions.length),
    call: first
      ? {
          id: first.id,
          question: cut(first.question, screenLimits.question),
          usd: pick?.usd ?? null,
        }
      : null,
    calls: lab.needsYou.length + (lab.omitted.needsYou ?? 0),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  const data = record(value);
  return data &&
    states.includes(data.state as Live['state']) &&
    text(data.text, screenLimits.text * 2) &&
    time(data.since)
    ? {
        state: data.state as Live['state'],
        text: data.text,
        since: data.since,
      }
    : undefined;
}

function direction(value: unknown): ScreenDirection | null {
  const data = record(value);
  if (!data) return null;
  const shown = live(data.live);
  return text(data.id, 100) &&
    text(data.title, screenLimits.text * 2) &&
    verdicts.includes(data.shown as ShownVerdict) &&
    (data.agent === null || text(data.agent, 100)) &&
    shown !== undefined &&
    (data.evidence === null || text(data.evidence, screenLimits.text * 2))
    ? {
        id: data.id,
        title: data.title,
        shown: data.shown as ShownVerdict,
        agent: data.agent,
        live: shown,
        evidence: data.evidence,
      }
    : null;
}

/**
 * A screen from the control channel, checked field by field. Null for
 * anything else: a terminal shows only what it could read.
 */
export function parseLabScreen(value: unknown): LabScreen | null {
  const data = record(value);
  const money = record(data?.money);
  const call = data?.call === null ? null : record(data?.call);
  if (
    !data ||
    !money ||
    !text(data.project, screenLimits.question * 2) ||
    !text(data.origin, 100) ||
    !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(data.origin) ||
    typeof data.app !== 'boolean' ||
    !amount(money.plansUsd) ||
    !amount(money.gpuUsd) ||
    !(money.gpuLimitUsd === null || amount(money.gpuLimitUsd)) ||
    !time(data.deadline) ||
    !(
      data.paused === null ||
      data.paused === 'person' ||
      data.paused === 'deadline'
    ) ||
    !Array.isArray(data.directions) ||
    data.directions.length > screenLimits.directions ||
    !count(data.more) ||
    !count(data.calls) ||
    (data.call !== null &&
      !(
        call &&
        text(call.id, 20) &&
        callId.test(call.id) &&
        text(call.question, screenLimits.question * 2) &&
        (call.usd === null || amount(call.usd))
      ))
  )
    return null;
  const directions = data.directions.map(direction);
  if (directions.some((entry) => entry === null)) return null;
  return {
    project: data.project,
    origin: data.origin,
    app: data.app,
    money: {
      plansUsd: money.plansUsd,
      gpuUsd: money.gpuUsd,
      gpuLimitUsd: money.gpuLimitUsd,
    },
    deadline: data.deadline,
    paused: data.paused,
    directions: directions as ScreenDirection[],
    more: data.more,
    call:
      call && typeof call.id === 'string' && typeof call.question === 'string'
        ? {
            id: call.id,
            question: call.question,
            usd: call.usd as number | null,
          }
        : null,
    calls: data.calls,
  };
}
