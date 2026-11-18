import type { LabView, Limit, Retry } from '../api/types.ts';
import { dayClock, money, tokens } from './format.ts';

/** The most tokens and US dollars that a budget can hold, and the largest disk limit, as the server allows. */
export const MAX_BUDGET_TOKENS = 10 ** 12;
export const MAX_BUDGET_DOLLARS = 1_000_000;
export const MAX_DISK_GB = 100_000;

/** The disk limit of a lab while the person sets none, in gigabytes. */
export const DEFAULT_DISK_GB = 100;

/** Each limit as a sentence names it. */
export const LIMIT_NAMES: Readonly<Record<Limit, string>> = {
  tokens: 'budget in tokens',
  dollars: 'budget in dollars',
  disk: 'disk limit',
};

/** What a model needs from the lab to know whether its agents stop. */
export type Stops = Pick<LabView, 'out_of_time'> & Partial<Pick<LabView, 'limit'>>;

/** Return whether the lab's agents stop now: its time ran out, or it reached its budget or its disk limit. */
export function halted(lab: Stops): boolean {
  return lab.out_of_time || (lab.limit ?? null) !== null;
}

/** Return why the lab's agents stop now, as the start of a sentence, or `null` while they do not. */
export function haltWords(lab: Stops): string | null {
  if (lab.out_of_time) return 'The lab is out of time';
  return lab.limit ? `The lab reached its ${LIMIT_NAMES[lab.limit]}` : null;
}

/** Return the top bar's clock for a lab at a limit other than its time. */
export function limitClock(limit: Limit): string {
  return limit === 'disk' ? 'Disk limit reached' : 'Budget reached';
}

/** Return what the lab spent against its budget, in one sentence, such as "Spent 1M of 5M tokens and $3.40." */
export function spentLine(lab: LabView): string {
  const { budget } = lab;
  const spentTokens =
    budget.tokens === null
      ? `${tokens(budget.spent_tokens)} tokens`
      : `${tokens(budget.spent_tokens)} of ${tokens(budget.tokens)} tokens`;
  const dollars =
    budget.dollars === null
      ? budget.spent_dollars > 0
        ? money(budget.spent_dollars)
        : null
      : `${money(budget.spent_dollars)} of ${money(budget.dollars)}`;
  const spent = dollars ? `${spentTokens} and ${dollars}` : spentTokens;
  const none = budget.tokens === null && budget.dollars === null ? ' No budget.' : '';
  return `Spent ${spent}.${none}`;
}

/** Return a count of bytes as `820 MB` or `12.3 GB`, in units of 1024. */
export function bytes(count: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = count;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return `${shown} ${units[unit] ?? 'bytes'}`;
}

/** Return the lab's disk use against its limit, in one sentence, such as "Files: 12.3 GB of 100 GB." */
export function diskLine(lab: LabView): string {
  const limit = lab.settings.disk.limit_gb;
  if (lab.disk === null) {
    return limit
      ? `Files: not measured yet. Limit: ${limit} GB.`
      : 'Files: not measured yet. No limit.';
  }
  const total = bytes(lab.disk.total);
  return limit ? `Files: ${total} of ${limit} GB.` : `Files: ${total}. No limit.`;
}

/**
 * Return a field's text as a whole number from 1 to `max`, `null` for an empty field, or `undefined` when the text
 * is no such number. Commas and spaces between digits are allowed, as in `5,000,000`.
 */
export function wholeField(text: string, max: number): number | null | undefined {
  const plain = text.replace(/[\s,_]/g, '');
  if (plain === '') return null;
  if (!/^\d+$/.test(plain)) return undefined;
  const value = Number(plain);
  return value >= 1 && value <= max ? value : undefined;
}

/** Return a field's text as an amount above zero and up to `max`, `null` for an empty field, or `undefined`. */
export function amountField(text: string, max: number): number | null | undefined {
  const plain = text.replace(/[\s,$]/g, '');
  if (plain === '') return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(plain)) return undefined;
  const value = Number(plain);
  return value > 0 && value <= max ? value : undefined;
}

/** Return the line of a seat whose harness failed and waits, such as "Provider limit, tries again at 14:20". */
export function retryLine(retry: Retry, now: Date): string {
  const why = retry.provider_limit ? 'Provider limit' : 'Harness failed';
  const times = retry.failures > 1 ? ` (${retry.failures} failures in a row)` : '';
  return `${why}, tries again at ${dayClock(retry.at, now)}${times}`;
}
