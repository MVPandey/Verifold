/**
 * The lab's words that the app and the terminal share: durations and
 * deadlines, a direction's verdict and its one line, the money line, and the
 * lines about a planner that did not make a plan. The person reads the same
 * words in either place. It takes plain values, as the protocol's records
 * hold them, and imports only call-words.ts.
 */
import { usd } from './call-words.ts';

const minute = 60_000;

/** A duration in plain words: "40 s", "6 min", "1 h 20 min", "3 days". */
export function span(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / minute);
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

/** Since a time, as a duration: "6 min". */
export function since(at: string, now: number): string {
  return span(now - Date.parse(at));
}

/**
 * A deadline. Within the next six days, the weekday and time: "Fri 18:00".
 * Further out, in the past, or on today's weekday next week, the date as
 * well, so a weekday is never ambiguous: "Mon 27 Oct, 07:00".
 */
export function due(at: string, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const days = (date.getTime() - now) / (24 * 60 * minute);
  const nextWeek = date.getDay() === new Date(now).getDay() && days > 1;
  if (days >= 0 && days < 6 && !nextWeek)
    return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  const day = date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return `${day}, ${time}`;
}

/** A direction's verdict as the screens show it. */
export type ShownVerdict =
  | 'holds'
  | 'disputed'
  | 'ruled-out'
  | 'leading'
  | 'open'
  | 'stopped';

/** The fields of a direction that its verdict reads, as the protocol's `Direction` has them. */
export interface VerdictFields {
  readonly verdict: 'open' | 'leading' | 'holds-up' | 'ruled-out';
  /** A post of the direction has an objection that no check settled yet. */
  readonly disputed: boolean;
  readonly state: 'open' | 'stopped' | 'closed';
}

/** The verdict of a direction. An objection that no check settled shows over the verdict. */
export function shownVerdict(direction: VerdictFields): ShownVerdict {
  if (direction.verdict === 'ruled-out') return 'ruled-out';
  if (direction.disputed) return 'disputed';
  if (direction.verdict === 'holds-up') return 'holds';
  if (direction.verdict === 'leading') return 'leading';
  return direction.state === 'open' ? 'open' : 'stopped';
}

export const verdictLabels: Readonly<Record<ShownVerdict, string>> = {
  holds: 'Holds up',
  disputed: 'Disputed',
  'ruled-out': 'Ruled out',
  leading: 'Leading',
  open: 'Not settled',
  stopped: 'Stopped',
};

/** One line about an agent now, as the protocol's `Live` has it. */
export interface LiveFields {
  readonly state: 'working' | 'waiting' | 'idle' | 'ended';
  readonly text: string;
  /** When the step or the wait began. */
  readonly since: string | null;
}

/**
 * A direction's one line. While its agent works, the agent's live step and
 * how long it runs: "Running plant_errors.py · 6 min". Otherwise the
 * evidence for the verdict, with a wait for the person after it: "Gap 34%
 * smaller on seed 1 · waiting for you". Without evidence, the live line.
 */
export function directionLine(
  evidence: string | null,
  live: LiveFields | null,
  now: number,
): { readonly working: boolean; readonly text: string } {
  if (live?.state === 'working')
    return {
      working: true,
      text: live.since ? `${live.text} · ${since(live.since, now)}` : live.text,
    };
  return {
    working: false,
    text: evidence
      ? `${evidence}${live?.state === 'waiting' ? ` · ${lower(live.text)}` : ''}`
      : (live?.text ?? ''),
  };
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** How a planner ended before the plan: the person stopped it, it closed its direction, or it stopped by itself too often. */
export type PlannerEnd = 'stopped' | 'closed' | 'crashed';

/**
 * Before the plan, a planner that does not make one: `missing` when the lab
 * has no planner and opens none, else how its planner ended.
 */
export type PlannerState = 'missing' | PlannerEnd;

/**
 * The state of the lab's planner, from the protocol's `Lab` and the status
 * of its planner. Null: the planner works, the lab has its plan, or an
 * earlier server does not say whether it opens a planner.
 */
export function plannerState(
  lab: {
    readonly plan: unknown;
    readonly planner?: string | null;
    readonly plannerStarting?: boolean;
  },
  status: string | undefined,
): PlannerState | null {
  if (lab.plan) return null;
  if (!lab.planner) return lab.plannerStarting === false ? 'missing' : null;
  return status === 'stopped' || status === 'closed' || status === 'crashed'
    ? status
    : null;
}

const plannerEnds: Readonly<Record<PlannerEnd, string>> = {
  stopped: 'You stopped the planner before it made a plan.',
  closed: 'The planner closed its direction before it made a plan.',
  crashed: 'The planner stopped by itself too often before it made a plan.',
};

/**
 * The line about a planner that ended before the plan. `act`: the person can
 * open a direction, and start a crashed planner again. Only a crash can
 * start again.
 */
export function plannerEndLine(end: PlannerEnd, act: boolean): string {
  if (!act) return plannerEnds[end];
  return end === 'crashed'
    ? `${plannerEnds[end]} Open a direction yourself, or start the planner again.`
    : `${plannerEnds[end]} Open a direction yourself to continue.`;
}

/**
 * The line of a lab with no directions yet. `missing`: the lab has no
 * planner and opens none. `act`: the person can open a direction.
 */
export function noDirectionsLine(missing: boolean, act: boolean): string {
  if (!missing)
    return 'The planner is reading. Directions show here when the plan is ready.';
  return act
    ? 'The planner did not start. Open a direction yourself.'
    : 'The planner did not start.';
}

/** A piece of the money line. `strong`: a value. Otherwise the muted words around it. */
export interface MoneyPiece {
  readonly text: string;
  readonly strong: boolean;
}

/**
 * The money line, in parts: "Due Fri 18:00", "≈$3.10 plans", "$4.20 of
 * $25 GPU" and, with a monthly limit, "$37.20 of $100 this month". The
 * screens join the parts with " · ". `deadline`: the end of the lab's time
 * budget, or null without one.
 */
export function moneyLine(
  money: {
    readonly plansUsd: number;
    readonly gpuUsd: number;
    readonly gpuLimitUsd: number | null;
    readonly month?: { readonly spentUsd: number; readonly limitUsd: number };
  },
  deadline: string | null,
  now: number,
): readonly (readonly MoneyPiece[])[] {
  const muted = (text: string): MoneyPiece => ({ text, strong: false });
  const strong = (text: string): MoneyPiece => ({ text, strong: true });
  return [
    ...(deadline ? [[muted('Due'), strong(due(deadline, now))]] : []),
    [strong(`≈${usd(money.plansUsd)}`), muted('plans')],
    [
      strong(usd(money.gpuUsd)),
      muted(
        money.gpuLimitUsd === null ? 'GPU' : `of ${usd(money.gpuLimitUsd)} GPU`,
      ),
    ],
    ...(money.month
      ? [
          [
            strong(usd(money.month.spentUsd)),
            muted(`of ${usd(money.month.limitUsd)} this month`),
          ],
        ]
      : []),
  ];
}
