import type { Choice } from './choices.ts';
import type { AskHint, BriefDecision, CliIO, SetupStep } from './commands.ts';
import { SessionActionError } from './session.ts';
import { TranscriptLog } from './transcript.ts';

export type SetupPrompt =
  | {
      readonly id: number;
      readonly kind: 'ask';
      readonly question: string;
      readonly hint?: AskHint;
    }
  | {
      readonly id: number;
      readonly kind: 'choice';
      readonly question: string;
      readonly choices: readonly Choice[];
      readonly initial: string;
    }
  | {
      readonly id: number;
      readonly kind: 'review';
      readonly brief: string;
      readonly final: boolean;
    };

/** One line of the setup transcript. `agent` is harness text. `tool` is an observed harness event. */
export interface SetupLine {
  readonly at: string;
  readonly source: 'verifold' | 'agent' | 'tool' | 'you';
  readonly text: string;
}

export interface SetupView {
  readonly step: SetupStep | null;
  readonly lines: readonly SetupLine[];
  readonly prompt: SetupPrompt | null;
  readonly busy: { readonly label: string; readonly startedAt: string } | null;
  readonly outcome: 'running' | 'done' | 'stopped';
  readonly error: string | null;
}

function fail(message: string): never {
  throw new SessionActionError(message);
}

/** Terminal wording that the desk does not need, such as "[y/N]:" at the end. */
function plain(question: string): string {
  return question
    .replace(/^\d+ \/ [^·]+·\s*/, '')
    .replace(/\s*\[y\/N\]:\s*$/i, '')
    .replace(/:\s*$/, '')
    .trim();
}

/**
 * Runs the existing setup flow in the desk. Each question waits for one answer
 * from the desk, and the flow keeps its own consent steps, limits, and retries.
 * The terminal shows each step as one line.
 */
export class SetupBridge {
  readonly io: CliIO;
  /** Harness runs during setup. Setup keeps them in memory only. */
  readonly transcript = new TranscriptLog();
  private readonly signal: AbortSignal;
  private nextId = 1;
  private pending: {
    readonly prompt: SetupPrompt;
    readonly settle: (value: unknown) => void;
  } | null = null;
  private lines: SetupLine[] = [];
  private step: SetupStep | null = null;
  private busy: SetupView['busy'] = null;
  private outcome: SetupView['outcome'] = 'running';
  private error: string | null = null;

  constructor(terminal: CliIO, signal: AbortSignal) {
    this.signal = signal;
    const feed = (text: string): void => terminal.progress?.(text);
    this.io = {
      interactive: true,
      out: terminal.out,
      ask: (question, hint) =>
        this.wait<string>({
          kind: 'ask',
          question:
            hint?.kind === 'text' && hint.label ? hint.label : plain(question),
          ...(hint ? { hint } : {}),
        }),
      select: (question, choices, initial) =>
        this.wait<string>({
          kind: 'choice',
          question: plain(question),
          choices,
          initial,
        }),
      review: (brief, final) =>
        this.wait<BriefDecision>({ kind: 'review', brief, final }),
      progress: (text, source) => this.line(source ?? 'verifold', text),
      busy: async (label, work) => {
        this.busy = { label, startedAt: new Date().toISOString() };
        feed(`Setup: ${label}`);
        try {
          return await work();
        } finally {
          this.busy = null;
        }
      },
      step: (name) => {
        this.step = name;
        feed(`Setup step in the desk: ${name}`);
      },
    };
  }

  view(): SetupView {
    return {
      step: this.step,
      lines: this.lines,
      prompt: this.pending?.prompt ?? null,
      busy: this.busy,
      outcome: this.outcome,
      error: this.error,
    };
  }

  /** Run the setup flow. The result or the error stays visible in the desk. */
  async run<T>(work: (io: CliIO) => Promise<T>): Promise<T> {
    try {
      const result = await work(this.io);
      this.outcome = 'done';
      return result;
    } catch (error) {
      this.outcome = 'stopped';
      this.error =
        error instanceof Error && error.name === 'AbortError'
          ? 'Setup was cancelled. Nothing was saved for this project.'
          : `Setup stopped: ${error instanceof Error ? error.message : 'unknown error'}`;
      throw error;
    } finally {
      this.pending = null;
      this.busy = null;
    }
  }

  /** Answer the open prompt. The value must fit the prompt that the desk showed. */
  answer(id: unknown, value: unknown): void {
    const pending = this.pending;
    if (!pending || pending.prompt.id !== id)
      fail('That question is no longer open. Refresh the desk.');
    const { prompt } = pending;
    if (prompt.kind === 'review') {
      const decision = this.decision(value);
      this.line(
        'you',
        decision.action === 'accept'
          ? 'Accepted the brief.'
          : decision.action === 'edit'
            ? 'Edited the brief and accepted my version.'
            : decision.action === 'cancel'
              ? 'Cancelled setup.'
              : `Asked for changes: ${decision.text}`,
      );
      this.pending = null;
      pending.settle(decision);
      return;
    }
    if (typeof value !== 'string' || value.length > 100_000)
      fail('Write an answer of at most 100,000 characters.');
    if (prompt.kind === 'choice') {
      const choice = prompt.choices.find((entry) => entry.value === value);
      if (!choice) fail('Choose one of the listed options.');
      this.line('you', choice.label);
    } else
      this.line(
        'you',
        prompt.hint?.kind === 'confirm'
          ? /^(y|yes)$/i.test(value)
            ? prompt.hint.yes
            : prompt.hint.no
          : ((prompt.hint?.kind === 'text'
              ? prompt.hint.actions?.find((action) => action.value === value)
                  ?.label
              : undefined) ??
              (value.trim() || 'No answer')),
      );
    this.pending = null;
    pending.settle(value);
  }

  private decision(value: unknown): BriefDecision {
    const data =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : {};
    if (data.action === 'accept' || data.action === 'cancel')
      return { action: data.action };
    if (
      data.action === 'feedback' &&
      typeof data.text === 'string' &&
      data.text.trim() &&
      data.text.length <= 4000
    )
      return { action: 'feedback', text: data.text.trim() };
    if (
      data.action === 'edit' &&
      typeof data.brief === 'string' &&
      data.brief.trim() &&
      data.brief.length <= 11_000
    )
      return { action: 'edit', brief: data.brief };
    fail('Accept the brief, ask for changes, edit it, or cancel setup.');
  }

  private wait<T>(prompt: DistributiveOmit<SetupPrompt, 'id'>): Promise<T> {
    this.signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        this.pending = null;
        reject(new DOMException('Setup cancelled.', 'AbortError'));
      };
      this.signal.addEventListener('abort', abort, { once: true });
      this.pending = {
        prompt: { ...prompt, id: this.nextId++ } as SetupPrompt,
        settle: (value) => {
          this.signal.removeEventListener('abort', abort);
          resolve(value as T);
        },
      };
    });
  }

  private line(source: SetupLine['source'], text: string): void {
    this.lines = [
      ...this.lines,
      { at: new Date().toISOString(), source, text: text.slice(0, 12_000) },
    ].slice(-200);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
