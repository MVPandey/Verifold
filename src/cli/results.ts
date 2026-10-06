import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionActionError } from './session.ts';

/** The result of one check of the chosen direction. A judgement waits for the person. */
export type CheckOutcome = 'passed' | 'failed' | 'partial' | 'judgement';

export interface CheckResult {
  /** The check's place in the direction's list, from 1. */
  readonly check: number;
  readonly result: CheckOutcome;
  /** What the evidence shows, in the coordinator's words. */
  readonly value: string;
  /** Accepted project files that show it. */
  readonly evidence: readonly string[];
  /** Why the coordinator reports this result. A model claim. */
  readonly reason: string;
  /** For a judgement: what the person decides. */
  readonly question?: string;
  readonly at: string;
  /** The person's ruling on a judgement. It is final. */
  readonly ruling?: {
    readonly result: Exclude<CheckOutcome, 'judgement'>;
    readonly reason: string;
    readonly at: string;
  };
}

export interface Claim {
  readonly text: string;
  /** Accepted project files or web sources. */
  readonly evidence: readonly string[];
}

export interface Answer {
  readonly statement: string;
  readonly claims: readonly Claim[];
  readonly at: string;
  /** The person's sign-off, or a request for more work. */
  readonly decision?: {
    readonly kind: 'accepted' | 'more';
    readonly at: string;
    readonly note?: string;
  };
}

/** The results of one chosen direction. */
export interface Results {
  readonly schemaVersion: 1;
  /** The direction that these results belong to. */
  readonly direction: string;
  readonly checks: readonly CheckResult[];
  readonly answer: Answer | null;
}

export const resultLimits = {
  value: 500,
  reason: 2000,
  question: 500,
  evidence: 10,
  statement: 2000,
  claims: 12,
  claim: 500,
  note: 4000,
} as const;

function fail(message: string): never {
  throw new SessionActionError(message);
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail(`Write the ${name}, up to ${max} characters.`);
  return value.trim();
}

const outcomes: readonly CheckOutcome[] = [
  'passed',
  'failed',
  'partial',
  'judgement',
];

/**
 * The results of the chosen direction in .verifold/results.json. The
 * coordinator reports each check and proposes the answer. The person rules on
 * judgements and signs off. Every write replaces the file atomically.
 */
export class ResultsStore {
  private readonly root: string;
  private results: Results | null = null;

  constructor(root: string) {
    this.root = root;
  }

  private get file(): string {
    return join(this.root, '.verifold', 'results.json');
  }

  /** Read the saved results, if any. An unreadable record reads as none. */
  async load(): Promise<void> {
    try {
      const stats = await lstat(this.file);
      if (!stats.isFile() || stats.size > 2_000_000) return;
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (
        value &&
        typeof value === 'object' &&
        'schemaVersion' in value &&
        value.schemaVersion === 1 &&
        'direction' in value &&
        typeof value.direction === 'string' &&
        'checks' in value &&
        Array.isArray(value.checks) &&
        'answer' in value
      )
        this.results = value as Results;
    } catch {
      /* No results yet, or an unreadable record. */
    }
  }

  /** The saved results, whatever their direction. */
  current(): Results | null {
    return this.results;
  }

  /** The results of a direction. Results of another direction do not count. */
  read(direction: string | null): Results | null {
    return direction && this.results?.direction === direction
      ? this.results
      : null;
  }

  /**
   * The coordinator reports one check. The evidence must be files that a
   * person or the coordinator accepted. A person's ruling stays final.
   */
  async report(
    direction: string,
    checks: readonly string[],
    accepted: ReadonlySet<string>,
    input: Record<string, unknown>,
  ): Promise<CheckResult> {
    const check = input.check;
    if (
      typeof check !== 'number' ||
      !Number.isInteger(check) ||
      check < 1 ||
      check > checks.length
    )
      fail(`Name a check from 1 to ${checks.length}.`);
    const result = outcomes.find((entry) => entry === input.result);
    if (!result) fail('The result is passed, failed, partial, or judgement.');
    const evidence = Array.isArray(input.evidence) ? input.evidence : [];
    if (
      !evidence.length ||
      evidence.length > resultLimits.evidence ||
      !evidence.every(
        (path): path is string =>
          typeof path === 'string' && accepted.has(path),
      )
    )
      fail(
        `Name 1 to ${resultLimits.evidence} accepted files as evidence. Accepted files: ${[...accepted].slice(0, 20).join(', ') || 'none yet'}.`,
      );
    const current = this.read(direction);
    if (current?.checks.some((entry) => entry.check === check && entry.ruling))
      fail(
        `The person ruled on check ${check}. Their decision is final. Do not report it again.`,
      );
    const entry: CheckResult = {
      check,
      result,
      value: text(
        input.value,
        'value that the evidence shows',
        resultLimits.value,
      ),
      evidence,
      reason: text(input.reason, 'reason', resultLimits.reason),
      ...(result === 'judgement'
        ? {
            question: text(
              input.question,
              'question for the person',
              resultLimits.question,
            ),
          }
        : {}),
      at: new Date().toISOString(),
    };
    await this.save({
      schemaVersion: 1,
      direction,
      checks: [
        ...(current?.checks ?? []).filter((saved) => saved.check !== check),
        entry,
      ].sort((a, b) => a.check - b.check),
      answer: current?.answer ?? null,
    });
    return entry;
  }

  /** The coordinator proposes the answer. An accepted answer stays until the person asks for more work. */
  async propose(
    direction: string,
    accepted: ReadonlySet<string>,
    input: Record<string, unknown>,
  ): Promise<Answer> {
    const current = this.read(direction);
    if (current?.answer?.decision?.kind === 'accepted')
      fail('The person accepted the answer. Wait for their next step.');
    const raw = Array.isArray(input.claims) ? input.claims : [];
    if (!raw.length || raw.length > resultLimits.claims)
      fail(`Give 1 to ${resultLimits.claims} claims.`);
    const claims = raw.map((claim: unknown): Claim => {
      const entry =
        claim && typeof claim === 'object'
          ? (claim as Record<string, unknown>)
          : {};
      const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
      if (
        evidence.length > resultLimits.evidence ||
        !evidence.every(
          (item): item is string =>
            typeof item === 'string' &&
            (accepted.has(item) || /^https?:\/\/\S{1,2000}$/.test(item)),
        )
      )
        fail(
          `Give each claim up to ${resultLimits.evidence} pieces of evidence: accepted files or web addresses.`,
        );
      return {
        text: text(entry.text, 'claim', resultLimits.claim),
        evidence,
      };
    });
    const answer: Answer = {
      statement: text(input.statement, 'statement', resultLimits.statement),
      claims,
      at: new Date().toISOString(),
    };
    await this.save({
      schemaVersion: 1,
      direction,
      checks: current?.checks ?? [],
      answer,
    });
    return answer;
  }

  /** The person rules on a check that waits for their judgement. */
  async rule(
    direction: string,
    check: unknown,
    result: unknown,
    reason: unknown,
  ): Promise<CheckResult> {
    const current = this.read(direction);
    const entry = current?.checks.find(
      (saved) => saved.check === check && saved.result === 'judgement',
    );
    if (!current || !entry || entry.ruling)
      fail('That check does not wait for your judgement. Refresh the desk.');
    if (result !== 'passed' && result !== 'failed' && result !== 'partial')
      fail('Choose passed, partly passed, or failed.');
    const ruled: CheckResult = {
      ...entry,
      ruling: {
        result,
        reason: text(reason, 'reason for your ruling', resultLimits.reason),
        at: new Date().toISOString(),
      },
    };
    await this.save({
      ...current,
      checks: current.checks.map((saved) => (saved === entry ? ruled : saved)),
    });
    return ruled;
  }

  /** The person accepts the answer, or asks for more work with a note. Open judgements come first. */
  async decide(
    direction: string,
    kind: unknown,
    note: unknown,
  ): Promise<Answer> {
    const current = this.read(direction);
    const answer = current?.answer;
    if (!current || !answer || answer.decision)
      fail('No answer waits for your decision. Refresh the desk.');
    if (kind !== 'accepted' && kind !== 'more')
      fail('Accept the answer, or ask for more work.');
    if (
      kind === 'accepted' &&
      current.checks.some(
        (entry) => entry.result === 'judgement' && !entry.ruling,
      )
    )
      fail('Settle the open judgements first.');
    const decided: Answer = {
      ...answer,
      decision: {
        kind,
        at: new Date().toISOString(),
        ...(kind === 'more'
          ? { note: text(note, 'note for the coordinator', resultLimits.note) }
          : {}),
      },
    };
    await this.save({ ...current, answer: decided });
    return decided;
  }

  private async save(results: Results): Promise<void> {
    const folder = join(this.root, '.verifold');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = join(
      folder,
      `.results.${randomBytes(4).toString('hex')}.tmp`,
    );
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(results, null, 2)}\n`);
      } finally {
        await file.close();
      }
      await rename(temporary, this.file);
      this.results = results;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
