import type { CliIO } from './commands.ts';
import { runHarness } from './harness.ts';
import { runResearch, selectIdea, type ResearchOptions } from './research.ts';
import { SessionActionError } from './session.ts';
import { loadWorkspace } from './storage.ts';

/** One line of the research feed. Tool lines come from the harness protocol. Status lines come from Verifold. */
export interface ResearchActivity {
  readonly at: string;
  readonly kind: 'tool' | 'status';
  readonly text: string;
}

export interface ResearchView {
  readonly running: boolean;
  /** The current or the latest step. */
  readonly step: string | null;
  readonly startedAt: string | null;
  readonly events: readonly ResearchActivity[];
}

export interface ResearchRunnerOptions {
  /** Ctrl+C in the owner terminal. */
  readonly signal: AbortSignal;
  /** The owner terminal. Plan and report text go there, as before. */
  readonly io: CliIO;
  /** Why research cannot start now, for example a running session. */
  readonly busy: () => string | null;
  readonly onRunning: (running: boolean) => void;
  readonly harness?: typeof runHarness;
}

function fail(message: string): never {
  throw new SessionActionError(message);
}

/**
 * Runs research steps inside the project owner, one at a time. The desk and the
 * owner terminal call the same methods. A cancel keeps the saved checkpoint and
 * the attempt files, the same as Ctrl+C.
 */
export class ResearchRunner {
  private readonly root: string;
  private readonly options: ResearchRunnerOptions;
  private controller: AbortController | null = null;
  private work: Promise<void> | null = null;
  private starting = false;
  private step: string | null = null;
  private startedAt: string | null = null;
  private events: ResearchActivity[] = [];

  constructor(root: string, options: ResearchRunnerOptions) {
    this.root = root;
    this.options = options;
  }

  /** A research step runs. A step that is still checking its input does not count. */
  get running(): boolean {
    return this.work !== null;
  }

  view(): ResearchView {
    return {
      running: this.running,
      step: this.step,
      startedAt: this.startedAt,
      events: this.events,
    };
  }

  /** Start one research step in the background. Fails before the harness starts when the step is not possible. */
  async start(input: ResearchOptions): Promise<void> {
    if (this.running || this.starting)
      fail('Research is already running. Wait for it, or cancel it.');
    const reason = this.options.busy();
    if (reason) fail(reason);
    this.starting = true;
    let phase: string | undefined;
    try {
      const workspace = await loadWorkspace(this.root);
      phase = workspace.research?.phase;
      if (workspace.selectedId)
        fail('A direction is chosen, so research cannot change it.');
      if (input.approve && phase !== 'awaiting-plan-review')
        fail('No plan waits for approval.');
      if (
        input.feedback !== undefined &&
        phase !== 'awaiting-plan-review' &&
        phase !== 'directions'
      )
        fail('Feedback needs a plan or directions to revise.');
      if (!phase && !input.topic?.trim())
        fail('Write the question that research should explore.');
      for (const text of [input.topic, input.feedback])
        if (text !== undefined && (!text.trim() || text.length > 4000))
          fail('Write between 1 and 4000 characters.');
    } finally {
      this.starting = false;
    }
    const search =
      phase === 'needs-research' ||
      phase === 'directions' ||
      (phase === 'awaiting-plan-review' && input.approve === true);
    this.step = search
      ? 'Searching sources and comparing directions'
      : 'Planning research roles and scope';
    this.startedAt = new Date().toISOString();
    this.events = [];
    const controller = new AbortController();
    this.controller = controller;
    const signal = AbortSignal.any([this.options.signal, controller.signal]);
    const harness = this.options.harness ?? runHarness;
    this.note('status', `Research started: ${this.step}.`);
    this.options.onRunning(true);
    this.work = runResearch(
      this.root,
      input,
      {
        // Research in the owner never asks in the terminal. Decisions come from the desk or a terminal command.
        interactive: false,
        ask: () => Promise.reject(new Error('Research does not ask here.')),
        out: () => {},
        ...(this.options.io.progress
          ? { progress: this.options.io.progress }
          : {}),
      },
      signal,
      (request) =>
        harness({
          ...request,
          onActivity: (message, kind) =>
            this.note('tool', message, undefined, kind === 'notice'),
        }),
    )
      .then((workspace) => {
        const next = workspace.research?.phase;
        if (next === 'awaiting-plan-review')
          this.note(
            'status',
            'The plan is ready. Approve it, or ask for changes.',
            'Type /approve, or /feedback and your changes.',
          );
        else if (next === 'directions')
          this.note(
            'status',
            'The directions are ready. Choose one, or ask for changes.',
            'Type /select and a direction ID, or /feedback and your changes.',
          );
        else this.note('status', 'The research step ended.');
      })
      .catch((error: unknown) => {
        this.note(
          'status',
          signal.aborted
            ? 'The research step was cancelled. The saved checkpoint and the attempt files remain.'
            : `The research step failed: ${error instanceof Error ? error.message : 'unknown error'} The saved checkpoint and the attempt files remain.`,
        );
      })
      .finally(() => {
        this.work = null;
        this.controller = null;
        this.options.onRunning(false);
      });
  }

  cancel(): void {
    if (!this.controller) fail('No research step is running.');
    this.controller.abort();
  }

  /** Lock one direction. Research cannot change the project afterwards. */
  async select(id: unknown): Promise<void> {
    if (this.running || this.starting)
      fail('Wait for research to end before you choose a direction.');
    this.starting = true;
    try {
      await selectIdea(this.root, id);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'The choice failed.');
    } finally {
      this.starting = false;
    }
    this.note('status', 'You chose a direction. Research cannot change it.');
  }

  /** Wait until the current step ends. */
  async settled(): Promise<void> {
    await this.work;
  }

  /** Status lines and notices also go to the terminal. Harness events stay in the desk. */
  private note(
    kind: ResearchActivity['kind'],
    text: string,
    terminalHint?: string,
    notice = kind === 'status',
  ): void {
    this.events = [
      ...this.events,
      { at: new Date().toISOString(), kind, text: text.slice(0, 2000) },
    ].slice(-300);
    if (notice)
      this.options.io.progress?.(
        terminalHint ? `${text} ${terminalHint}` : text,
      );
  }
}
