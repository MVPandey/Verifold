import type {
  AgentView,
  AllowanceView,
  BudgetLine,
  DashboardMeta,
  HeadlineView,
  LabView,
  MeasureView,
  Post,
} from '../api/types.ts';
import { authorName } from './agents.ts';
import { amount } from './allowances.ts';
import { ago, dayClock } from './format.ts';

/** Where the dashboard opens: the frame's own page on this server, which holds nothing of the lab. */
export const FRAME_PATH = '/frame';

/**
 * The sandbox of the frame. Scripts run, and nothing else: no origin of the app, so no storage and no token of it,
 * no form, no window, no move of the page that holds the frame, and no download. The frame's page carries the same
 * sandbox in its own policy.
 */
export const FRAME_SANDBOX = 'allow-scripts';

/** What the frame receives from the app: the text of the page, as one message. */
export interface FrameWindow {
  postMessage(message: string, targetOrigin: string): void;
}

/**
 * Put the agents' page into the frame. The frame's own page has an origin of its own, so the message goes to any
 * origin, and it carries the page's text and nothing else: no token, no address of the app.
 */
export function sendPage(frame: FrameWindow | null | undefined, html: string): void {
  frame?.postMessage(html, '*');
}

/** What a mark on a measure looks like: the plain mark, the one of a rerun that held, or the one of a rerun that failed. */
export type MarkTone = 'quiet' | 'good' | 'bad';

/** A mark of the board on a measure: who reran it and what the rerun found. It never says whether the number is good. */
export interface Mark {
  readonly text: string;
  readonly tone: MarkTone;
}

function names(agents: readonly AgentView[], ids: readonly string[]): string {
  const called = ids.map((id) => authorName(agents, id));
  return called.length < 3
    ? called.join(' and ')
    : `${called.slice(0, -1).join(', ')}, and ${called.at(-1) ?? ''}`;
}

/** Return the board's mark on a measure: who reran it, whose rerun failed, or that nobody reran it. */
export function rerunMark(measure: MeasureView, agents: readonly AgentView[]): Mark {
  const held = measure.rerun_by.length > 0 ? `rerun by ${names(agents, measure.rerun_by)}` : '';
  const failed =
    measure.rerun_failed_by.length > 0
      ? `the rerun by ${names(agents, measure.rerun_failed_by)} failed`
      : '';
  const disputed = measure.standing === 'disputed' && !failed ? 'disputed' : '';
  const parts = [held || failed ? '' : 'not rerun', held, failed, disputed].filter(Boolean);
  return { text: parts.join(' · '), tone: failed ? 'bad' : held && !disputed ? 'good' : 'quiet' };
}

/** Return a measure's number with its unit, exactly as the record holds it. */
export function measureValue(measure: Pick<MeasureView, 'value' | 'unit'>): string {
  return measure.unit ? amount(measure.value, measure.unit) : measure.value;
}

/** One part of the status line: its number, and the words under it. */
export interface Stat {
  readonly key: string;
  readonly value: string;
  readonly words: string;
  /** The board's mark beside the words, for the headline number. */
  readonly mark?: Mark;
}

/** Return the headline number as a part of the status line, or `null` while nobody named one. */
export function headlineStat(
  headline: HeadlineView | null | undefined,
  agents: readonly AgentView[],
  now: Date,
): Stat | null {
  if (!headline) return null;
  const measure = headline.measure;
  if (!measure) return { key: 'headline', value: 'No measure yet', words: headline.label };
  return {
    key: 'headline',
    value: measureValue(measure),
    words: `${measure.label} · ${ago(measure.as_of, now)}`,
    mark: rerunMark(measure, agents),
  };
}

/** Return the actions of each allowance in force as a part of the status line, with how much of it is used. */
export function actionStats(lab: LabView, agents: readonly AgentView[]): readonly Stat[] {
  const live = inForce(lab);
  return live.map((view) => {
    const count = view.actions.length;
    const unit = view.terms.unit;
    const used = `${amount(view.drawn, unit)} of ${amount(view.terms.total, unit)} allowance used`;
    return {
      key: `actions-${view.allowance}`,
      value: `${count} ${count === 1 ? 'action' : 'actions'}`,
      words: live.length > 1 ? `${authorName(agents, view.terms.holder)}: ${used}` : used,
    };
  });
}

/** Return the allowances that are in force now. */
export function inForce(lab: LabView): readonly AllowanceView[] {
  return (lab.allowances ?? []).filter((view) => view.state === 'in_force');
}

/** Return the share of the lab's budget that it spent as a part of the status line, or `null` without a budget. */
export function budgetStat(budget: BudgetLine): Stat | null {
  const shares = [
    budget.tokens ? { share: budget.spent_tokens / budget.tokens, kind: 'token' } : null,
    budget.dollars ? { share: budget.spent_dollars / budget.dollars, kind: 'dollar' } : null,
  ].filter((item) => item !== null);
  const most = shares.reduce<(typeof shares)[number] | null>(
    (best, item) => (best === null || item.share > best.share ? item : best),
    null,
  );
  if (!most) return null;
  return {
    key: 'budget',
    value: `${String(Math.round(most.share * 100))}%`,
    words: `of the ${most.kind} budget spent`,
  };
}

/** The status line of the lab page: the parts that exist, and whether it shows the press that pauses every action. */
export interface StatusLine {
  readonly stats: readonly Stat[];
  readonly pause: boolean;
}

/** Return the lab's status line, or `null` for a lab with no headline number, no allowance in force, and no budget. */
export function statusLine(
  lab: LabView,
  agents: readonly AgentView[],
  now: Date,
): StatusLine | null {
  const headline = headlineStat(lab.headline_number, agents, now);
  const stats = [
    ...(headline ? [headline] : []),
    ...actionStats(lab, agents),
    ...(budgetStat(lab.budget) ? [budgetStat(lab.budget) as Stat] : []),
  ];
  const pause = inForce(lab).length > 0;
  return stats.length > 0 || pause ? { stats, pause } : null;
}

/** Return the board's line about the agents' page: who made it and how old it is. */
export function bylineParts(
  meta: DashboardMeta,
  agents: readonly AgentView[],
  now: Date,
): readonly string[] {
  return [
    `Made by ${authorName(agents, meta.by)}, an agent`,
    `Updated ${ago(meta.at, now)}`,
    "Numbers are the agents' own",
  ];
}

/** Return the headline number as the board's line shows it beside the page, with its mark, or `null`. */
export function headlineMark(
  headline: HeadlineView | null | undefined,
  agents: readonly AgentView[],
): Mark | null {
  if (!headline) return null;
  const measure = headline.measure;
  if (!measure) return { text: `${headline.label}: no measure yet`, tone: 'quiet' };
  const mark = rerunMark(measure, agents);
  return { text: `${measure.label} ${measureValue(measure)} · ${mark.text}`, tone: mark.tone };
}

/** Return who named the headline number, and why when the coordinator named it. */
export function namedLine(headline: HeadlineView, agents: readonly AgentView[], now: Date): string {
  if (headline.named_by === 'person') return `You named it ${dayClock(headline.named_at, now)}.`;
  const why = headline.why ? ` Why: ${headline.why}` : '';
  return `${authorName(agents, headline.named_by)}, the coordinator, named it ${dayClock(headline.named_at, now)}.${why}`;
}

/** Return the facts of a measure, a version of the dashboard, or a naming of the headline number, for its turn. */
export function measureParts(post: Post, now: Date): readonly (readonly [string, string])[] {
  if (post.kind === 'measure') {
    return [
      ['Holds for', dayClock(post.as_of, now)],
      ['Script', post.script],
      ['Output', post.output],
    ];
  }
  if (post.kind === 'dashboard') {
    const page = post.evidence[0]?.path ?? '';
    return [['Page', `${page} · ${size(post.size)}`]];
  }
  if (post.kind === 'headline_number' && post.why) return [['Why', post.why]];
  return [];
}

/** Return a size in bytes as `900 bytes`, `12 KB`, or `1.0 MB`. */
export function size(bytes: number): string {
  if (bytes < 1_000) return `${String(bytes)} bytes`;
  if (bytes < 1_000_000) return `${String(Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
