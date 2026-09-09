export type Purpose = 'R&D' | 'Publication' | 'Project';
export interface Idea {
  readonly id: string;
  readonly title: string;
  readonly area: string;
  readonly question: string;
  readonly rationale: string;
  readonly sourceTitle: string;
  readonly sourceUrl: string;
  readonly confounder: string;
}
export interface Criteria {
  readonly metric: string;
  readonly baseline: string;
  readonly threshold: number;
  readonly direction: 'lower' | 'higher';
  readonly seeds: readonly number[];
  readonly budgetUsd: number;
}
export interface Run {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly ideaId: string;
  readonly purpose: Purpose;
  readonly criteria: Criteria;
  readonly approvedBy: string;
  readonly status: 'awaiting-adapter';
  readonly events: readonly {
    readonly kind: string;
    readonly message: string;
    readonly at: string;
  }[];
}

/** Freeze a planning contract. This creates no execution and confers no verification status. */
export function registerRun(
  idea: Idea,
  purpose: Purpose,
  criteria: Criteria,
  approvedBy: string,
  id: string,
  at: string,
): Run {
  if (
    !criteria.metric.trim() ||
    !criteria.baseline.trim() ||
    !approvedBy.trim() ||
    !id.trim()
  )
    throw new Error('Metric, baseline, run ID, and approver are required.');
  if (!Number.isFinite(criteria.threshold))
    throw new Error('Threshold must be finite.');
  if (
    !Number.isFinite(criteria.budgetUsd) ||
    criteria.budgetUsd <= 0 ||
    criteria.budgetUsd > 1000
  )
    throw new Error('Budget must be between $0 and $1,000.');
  if (
    criteria.seeds.length < 3 ||
    new Set(criteria.seeds).size !== criteria.seeds.length ||
    !criteria.seeds.every(Number.isSafeInteger)
  )
    throw new Error('Provide at least three distinct integer seeds.');
  if (!Number.isFinite(Date.parse(at)))
    throw new Error('Timestamp is invalid.');
  const locked = Object.freeze({
    ...criteria,
    seeds: Object.freeze([...criteria.seeds]),
  });
  return Object.freeze({
    schemaVersion: 1,
    id,
    ideaId: idea.id,
    purpose,
    criteria: locked,
    approvedBy,
    status: 'awaiting-adapter',
    events: Object.freeze([
      Object.freeze({
        kind: 'criteria-locked',
        message: 'Human approved planning criteria. No compute launched.',
        at,
      }),
    ]),
  });
}

/** Exploratory threshold check only; missing or unexpected seeds are inconclusive. Never labels a run verified. */
export function evaluateCriteria(
  criteria: Criteria,
  observations: readonly { readonly seed: number; readonly value: number }[],
): 'met' | 'not-met' | 'inconclusive' {
  if (
    observations.length !== criteria.seeds.length ||
    new Set(observations.map((item) => item.seed)).size !==
      observations.length ||
    observations.some(
      (item) =>
        !criteria.seeds.includes(item.seed) || !Number.isFinite(item.value),
    )
  )
    return 'inconclusive';
  const mean =
    observations.reduce((total, item) => total + item.value, 0) /
    observations.length;
  return (
    criteria.direction === 'lower'
      ? mean <= criteria.threshold
      : mean >= criteria.threshold
  )
    ? 'met'
    : 'not-met';
}
