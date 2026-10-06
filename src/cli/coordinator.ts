import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Workspace } from './contracts.ts';
import { validateModel, type HarnessName } from './harness.ts';
import { messageLimits } from './messages.ts';
import { loadPrompt } from './prompts.ts';
import {
  readRecord,
  SessionActionError,
  type SessionManager,
  type SessionRecord,
  type SessionView,
} from './session.ts';
import type { AgentTool, AgentTools } from './session-hosts.ts';
import { replaced, type TaskEvent, type TaskManager } from './tasks.ts';
import { ResultsStore, type Results } from './results.ts';
import type { Compute } from './compute.ts';
import { spent, usd } from './leases.ts';
import { loadWorkspace } from './storage.ts';
import { workerLimit } from './workers.ts';

/**
 * The coordinator: one harness session that turns an objective into tasks for
 * the workers, reviews their versions, and settles objections. It acts only
 * through Verifold's tools, and each tool calls the same task operation that
 * the person uses, so runtime code checks every action. Events wake it with a
 * digest. A pause between events costs nothing.
 */

export const coordinatorLimits = {
  /** Tasks that one coordinator can create. */
  tasks: 12,
  wakeupsPerHour: 12,
  /** Events in one digest. The rest wait for the next one. */
  digest: 30,
  /** Events and actions kept in the record. */
  events: 200,
  actions: 300,
  /** Events that arrive within this time join one wakeup. */
  debounceMs: 20_000,
};

export interface CoordinatorEvent extends TaskEvent {
  readonly seq: number;
  readonly at: string;
}

/** One tool call of the coordinator, with its reason and Verifold's answer. */
export interface CoordinatorAction {
  /** The harness's call ID. A repeated call gets the same answer and changes nothing. */
  readonly key: string;
  readonly at: string;
  readonly tool: string;
  readonly input: string;
  readonly reason?: string;
  readonly ok: boolean;
  readonly result: string;
}

export interface CoordinatorState {
  readonly schemaVersion: 1;
  readonly objective: string;
  readonly host: HarnessName;
  readonly model: string | null;
  readonly startedAt: string;
  /** The person stopped the coordinator. It gets no more wakeups. */
  readonly stoppedAt: string | null;
  readonly session: string | null;
  /** Tasks that this coordinator created. */
  readonly created: number;
  /** Guided research: no task starts until the person approves the coordinator's plan. */
  readonly planApproved: boolean;
  /** The last event that a digest carried. */
  readonly cursor: number;
  readonly wakeups: readonly string[];
  readonly events: readonly CoordinatorEvent[];
  readonly actions: readonly CoordinatorAction[];
}

export interface CoordinatorView {
  readonly state: CoordinatorState;
  /** The checks and the answer, for the direction that they belong to. */
  readonly results?: Results | null;
  readonly session: SessionView | null;
  /** Events that wait for the next wakeup. */
  readonly waiting: number;
  /** The wakeup limit holds events until this time. */
  readonly limitedUntil: string | null;
}

function fail(message: string): never {
  throw new SessionActionError(message);
}

/** The chosen research direction as a first objective, or null without a choice. */
export function directionObjective(workspace: Workspace): string | null {
  const idea = workspace.candidates.find(
    (candidate) => candidate.id === workspace.selectedId,
  );
  return idea ? `${idea.title}\n\n${idea.recommendation}` : null;
}

/** The research brief and the chosen direction with its gates, for the coordinator's first turn. */
export function coordinatorContext(workspace: Workspace): string {
  const idea = workspace.candidates.find(
    (candidate) => candidate.id === workspace.selectedId,
  );
  return [
    workspace.context ? `Research brief:\n${workspace.context}` : '',
    idea
      ? `Chosen direction: ${idea.title}\n${idea.recommendation}\nProposed verification gates:\n${idea.gates.map((gate) => `- ${gate}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 20_000);
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class Coordinator {
  private readonly root: string;
  private readonly tasks: TaskManager;
  private readonly sessions: SessionManager;
  private readonly debounceMs: number;
  private state: CoordinatorState | null = null;
  private timer: NodeJS.Timeout | undefined;
  private limitedUntil: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** The saved session record after a restart, until the session resumes. */
  private saved: SessionRecord | null = null;
  /** Verifold is stopping. Tool calls change nothing. */
  private closing = false;
  /** The checks and the answer of the chosen direction. */
  private readonly results: ResultsStore;
  /** GPU pods: the person's limits and the leases. */
  private readonly compute: Compute | undefined;

  /** `sessions` is the coordinator's own session manager, outside the worker slots. */
  constructor(
    root: string,
    options: {
      readonly tasks: TaskManager;
      readonly sessions: SessionManager;
      readonly debounceMs?: number;
      readonly compute?: Compute;
    },
  ) {
    this.root = root;
    this.tasks = options.tasks;
    this.sessions = options.sessions;
    this.compute = options.compute;
    this.results = new ResultsStore(root);
    this.debounceMs = options.debounceMs ?? coordinatorLimits.debounceMs;
  }

  private get file(): string {
    return join(this.root, '.verifold', 'coordinator', 'state.json');
  }

  /** Read the saved coordinator and the results, if any. */
  async load(): Promise<void> {
    await this.results.load();
    try {
      const stats = await lstat(this.file);
      if (!stats.isFile() || stats.size > 4_000_000) return;
      const value = object(JSON.parse(await readFile(this.file, 'utf8')));
      if (
        value.schemaVersion === 1 &&
        typeof value.objective === 'string' &&
        (value.host === 'claude' || value.host === 'codex') &&
        Array.isArray(value.events) &&
        Array.isArray(value.actions) &&
        Array.isArray(value.wakeups) &&
        typeof value.cursor === 'number' &&
        typeof value.created === 'number' &&
        typeof value.planApproved === 'boolean'
      )
        this.state = value as unknown as CoordinatorState;
    } catch {
      /* No coordinator yet, or an unreadable record. */
    }
    // The session of an earlier owner shows as paused or interrupted, so the desk offers Resume.
    if (this.state?.session)
      this.saved = await readRecord(this.root, this.state.session);
  }

  view(): CoordinatorView | null {
    const state = this.state;
    if (!state) return null;
    return {
      state,
      session: state.session
        ? (this.sessions.view() ??
          (this.saved
            ? { record: this.saved, live: false, saveFailed: false }
            : null))
        : null,
      waiting: state.events.filter((event) => event.seq > state.cursor).length,
      limitedUntil: this.limitedUntil,
      results: this.results.current(),
    };
  }

  /** Start a coordinator for an objective. A stopped coordinator is replaced; its record stays in its session. */
  start(input: {
    readonly objective: unknown;
    readonly host: unknown;
    readonly model?: unknown;
    /** The research brief and the chosen direction. */
    readonly context?: string;
    /** The person approves the first task plan before any task starts. */
    readonly guided: boolean;
  }): Promise<void> {
    return this.serial(async () => {
      if (this.state && !this.state.stoppedAt)
        fail('The coordinator already runs. Stop it first.');
      const objective =
        typeof input.objective === 'string' &&
        input.objective.trim() &&
        input.objective.length <= 8000
          ? input.objective.trim()
          : fail('Write the objective, up to 8000 characters.');
      const host =
        input.host === 'claude' || input.host === 'codex'
          ? input.host
          : fail('Choose Claude Code or Codex.');
      const model =
        typeof input.model === 'string' && input.model.trim()
          ? input.model.trim()
          : null;
      try {
        validateModel(model ?? undefined);
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Invalid model.');
      }
      await this.save({
        schemaVersion: 1,
        objective,
        host,
        model,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        session: null,
        created: 0,
        planApproved: !input.guided,
        cursor: 0,
        wakeups: [],
        events: [],
        actions: [],
      });
      let session: string;
      try {
        session = await this.sessions.startCoordinator({
          host,
          ...(model ? { model } : {}),
          prompt: `${await loadPrompt('coordinator')}

Objective:
${objective}
${input.context ? `\n${input.context}\n` : ''}
Default harness for workers: ${host === 'claude' ? 'Claude Code' : 'Codex'}${model ? `, model ${model}` : ''}. Up to ${workerLimit} workers run at the same time. You can create up to ${coordinatorLimits.tasks} tasks.

${input.guided ? 'In this project, the person approves your first task plan before any task starts. Start now: read verifold_state, create the tasks for the first step, and end your turn with a short summary of the plan. Verifold wakes you when the person approves it or writes to you.' : 'Start now: read verifold_state, create the tasks for the first step, and start the ones that can run.'}`,
          tools: this.tools(),
        });
      } catch (error) {
        // A coordinator that did not start counts as stopped, so the person can start it again.
        await this.save({
          ...this.current(),
          stoppedAt: new Date().toISOString(),
        });
        throw error;
      }
      await this.save({ ...this.current(), session });
    });
  }

  /** Start the coordinator for the chosen direction, unless one already runs. */
  async startForDirection(workspace: Workspace): Promise<void> {
    if (this.state && !this.state.stoppedAt) return;
    const objective = directionObjective(workspace);
    if (!objective) return;
    await this.start({
      objective,
      host: workspace.host,
      ...(workspace.model ? { model: workspace.model } : {}),
      context: coordinatorContext(workspace),
      guided: workspace.research?.autonomy !== 'autonomous',
    });
  }

  /** The person approves the coordinator's task plan. Its tasks can start, and it wakes. */
  approvePlan(): Promise<void> {
    return this.serial(async () => {
      const state = this.current();
      if (state.stoppedAt || state.planApproved)
        fail('No task plan waits for your approval.');
      const status = this.sessions.view()?.record.status;
      if (status === 'running' || status === 'starting')
        fail(
          'The coordinator is still making its plan. Approve it when its turn ends.',
        );
      await this.save({ ...state, planApproved: true });
    }).then(() =>
      this.notify({
        kind: 'person',
        text: 'The person approved your task plan. Start the tasks that can run.',
      }),
    );
  }

  /** Stop the coordinator. Running workers finish their turns, and their versions wait for review. */
  stop(): Promise<void> {
    return this.serial(async () => {
      const state = this.current();
      if (state.stoppedAt) fail('The coordinator is already stopped.');
      clearTimeout(this.timer);
      this.timer = undefined;
      if (this.sessions.view()?.live)
        this.sessions.endTask('You stopped the coordinator.');
      await this.save({ ...state, stoppedAt: new Date().toISOString() });
    });
  }

  /** Continue a coordinator that paused when Verifold stopped, with its tools. */
  resume(): Promise<void> {
    return this.serial(async () => {
      const state = this.current();
      if (state.stoppedAt || !state.session)
        fail('Only a paused coordinator can resume.');
      await this.sessions.resume(state.session, this.tools());
      // A digest may have been cut by the stop. The next one says so.
      this.schedule(0);
    });
  }

  /** A task event. It waits for the next wakeup. */
  notify(event: TaskEvent): void {
    this.serial(async () => {
      const state = this.state;
      if (!state || state.stoppedAt) return;
      const seq = (state.events.at(-1)?.seq ?? 0) + 1;
      // The schedule comes first: the event is in memory even if the save fails.
      const saving = this.save({
        ...state,
        events: [
          ...state.events,
          {
            ...event,
            // One line of at most 2000 characters, so a digest stays small and its lines stay apart.
            text: event.text.replace(/[\r\n]+/g, ' ').slice(0, 2000),
            seq,
            at: new Date().toISOString(),
          },
        ].slice(-coordinatorLimits.events),
      });
      this.schedule();
      await saving;
    }).catch(() => {
      /* The next save writes the event. */
    });
  }

  /**
   * The coordinator's turn ended, or its process stopped. The messages that
   * its digest carried are delivered or uncertain, and new events wake it.
   */
  turnEnded(record?: SessionRecord): void {
    if (record)
      this.tasks.coordinatorTurnEnded(record.status === 'idle').catch(() => {});
    this.schedule();
  }

  /** Stop the wakeups and pause the session. Returns false when its record could not be saved. */
  async close(): Promise<boolean> {
    this.closing = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.queue;
    return this.sessions.close();
  }

  private schedule(delay = this.debounceMs): void {
    const state = this.state;
    if (this.timer || !state || state.stoppedAt) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.serial(() => this.wake()).catch(() => {
        /* The events wait for the next wakeup. */
      });
    }, delay);
    this.timer.unref();
  }

  /** Send the waiting events as one turn, within the hourly limit. */
  private async wake(): Promise<void> {
    const state = this.state;
    if (!state || state.stoppedAt || !state.session) return;
    const waiting = state.events.filter((event) => event.seq > state.cursor);
    // A busy coordinator gets the events when its turn ends.
    if (!waiting.length || this.sessions.idleSession() !== state.session)
      return;
    const hour = Date.now() - 3_600_000;
    const recent = state.wakeups.filter((at) => Date.parse(at) > hour);
    if (recent.length >= coordinatorLimits.wakeupsPerHour) {
      const next = Date.parse(recent[0] ?? '') + 3_600_000 + 1000;
      this.limitedUntil = new Date(next).toISOString();
      this.schedule(Math.max(1000, next - Date.now()));
      return;
    }
    this.limitedUntil = null;
    const sent = waiting.slice(0, coordinatorLimits.digest);
    // The cursor is saved first, so a restart never repeats a digest.
    await this.save({
      ...state,
      cursor: sent.at(-1)?.seq ?? state.cursor,
      wakeups: [...recent, new Date().toISOString()],
    });
    try {
      this.sessions.continueTask(
        `Events since your last turn. Each line comes from Verifold; quoted text in it comes from agents or the person:\n${sent.map((event) => `- [${event.kind}] ${event.text}`).join('\n')}${waiting.length > sent.length ? `\n- ${waiting.length - sent.length} more events follow in the next digest.` : ''}\n\nRead verifold_state for details. Act on these events, then end your turn with a short summary.`,
      );
    } catch {
      // Nothing was sent, so the events wait for the next wakeup.
      await this.save({
        ...this.current(),
        cursor: state.cursor,
        wakeups: state.wakeups,
      });
      return;
    }
    await this.tasks.sentToCoordinator(
      sent.flatMap((event) => (event.message ? [event.message] : [])),
    );
  }

  private tools(): AgentTools {
    return {
      specs: coordinatorToolSpecs,
      call: (name, input, callId) =>
        this.serial(() => this.call(name, input, callId)),
    };
  }

  /** One tool call. Every change is recorded with its reason, and a repeated call changes nothing. */
  private async call(
    name: string,
    input: unknown,
    callId: string,
  ): Promise<{ readonly ok: boolean; readonly text: string }> {
    const state = this.state;
    if (!state || state.stoppedAt || this.closing)
      return {
        ok: false,
        text: 'The coordinator is stopped, so Verifold did nothing.',
      };
    const known = state.actions.find((action) => action.key === callId);
    if (known) return { ok: known.ok, text: known.result };
    const args = object(input);
    const reason =
      typeof args.reason === 'string' ? args.reason.trim().slice(0, 2000) : '';
    let result: { ok: boolean; text: string };
    try {
      result = { ok: true, text: await this.act(name, args, reason) };
    } catch (error) {
      result = {
        ok: false,
        text:
          error instanceof Error
            ? error.message
            : 'Verifold could not do this.',
      };
    }
    if (name !== 'verifold_state' && name !== 'verifold_read') {
      const current = this.current();
      await this.save({
        ...current,
        actions: [
          ...current.actions,
          {
            key: callId,
            at: new Date().toISOString(),
            tool: name,
            input: JSON.stringify(args).slice(0, 2000),
            ...(reason ? { reason } : {}),
            ok: result.ok,
            result: result.text.slice(0, 2000),
          },
        ].slice(-coordinatorLimits.actions),
      });
    }
    return result;
  }

  private async act(
    name: string,
    args: Record<string, unknown>,
    reason: string,
  ): Promise<string> {
    const why = (): string =>
      reason || fail('Give a short reason. The person reads it.');
    switch (name) {
      case 'verifold_state':
        return this.describe();
      case 'verifold_read':
        return this.tasks.readVersionFile(args.task, args.version, args.path);
      case 'verifold_create_task': {
        const state = this.current();
        if (state.created >= coordinatorLimits.tasks)
          fail(
            `You created ${coordinatorLimits.tasks} tasks, the limit for this objective.`,
          );
        const id = await this.tasks.create(
          {
            title: args.title,
            objective: args.objective,
            inputs: args.inputs,
            writable: args.writable,
            output: args.output,
            host: args.host ?? state.host,
            // The coordinator's model belongs to its harness. Another harness uses its default.
            model:
              args.model ??
              ((args.host ?? state.host) === state.host ? state.model : null) ??
              undefined,
            minutes: args.minutes,
            dependencies: args.dependencies,
            network: args.network,
          },
          'coordinator',
          `Created by the coordinator: ${why()}`,
        );
        await this.save({ ...this.current(), created: state.created + 1 });
        return `Created ${id}.`;
      }
      case 'verifold_revise_task': {
        const task =
          (await this.tasks.get(args.task)) ??
          fail('That task does not exist.');
        const current = task.assignment;
        await this.tasks.edit(
          task.id,
          {
            title: args.title ?? current.title,
            objective: args.objective ?? current.objective,
            inputs: args.inputs ?? current.inputs.map((input) => input.path),
            writable: args.writable ?? current.writable,
            output: args.output ?? current.output,
            host: args.host ?? current.host,
            model:
              args.model ??
              ((args.host ?? current.host) === current.host
                ? current.model
                : null) ??
              undefined,
            minutes: args.minutes ?? current.minutes,
            dependencies: args.dependencies ?? current.dependencies,
            network: args.network ?? current.network,
            reason: `The coordinator: ${why()}`,
          },
          'coordinator',
        );
        return `Revised ${task.id}. It is open with revision ${task.revision + 1}.`;
      }
      case 'verifold_start_task':
        if (!this.current().planApproved)
          fail(
            'The person reviews your task plan first. End your turn with a short summary of the plan. Verifold wakes you when the person approves it or writes to you.',
          );
        await this.tasks.start(args.task, 'coordinator');
        return `Started ${String(args.task)}.`;
      case 'verifold_stop_task':
        await this.tasks.stop(args.task, 'coordinator');
        return 'Stopped the turn. Its work becomes a version for review.';
      case 'verifold_accept': {
        const task =
          (await this.tasks.get(args.task)) ??
          fail('That task does not exist.');
        const latest = task.attempts.at(-1)?.versions.at(-1);
        const files =
          args.files ??
          latest?.files
            .filter((file) => file.inScope && file.regular)
            .map((file) => file.path);
        const result = await this.tasks.accept(
          task.id,
          args.version,
          files,
          'coordinator',
          why(),
        );
        if ('conflicts' in result)
          fail(
            `These files changed in the project after the task started, so Verifold copied nothing: ${result.conflicts.join(', ')}. Ask for changes or reject the version.`,
          );
        return `Accepted ${task.id} version ${String(args.version)}: ${result.applied.join(', ')}.`;
      }
      case 'verifold_request_changes':
        await this.tasks.askForChanges(args.task, args.note, 'coordinator');
        return 'Sent your changes. The next version follows.';
      case 'verifold_reject':
        await this.tasks.reject(args.task, args.version, 'coordinator', why());
        return `Rejected ${String(args.task)} version ${String(args.version)}. The task is open again.`;
      case 'verifold_cancel_task':
        why();
        await this.tasks.cancel(args.task, 'coordinator');
        return `Cancelled ${String(args.task)}.`;
      case 'verifold_post': {
        const message = await this.tasks.post(
          args.to,
          args.text,
          'coordinator',
        );
        return `Posted ${message.id}.`;
      }
      case 'verifold_decide':
        await this.tasks.decideMessage(
          args.message,
          args.decision,
          why(),
          'coordinator',
        );
        return `Recorded your decision on ${String(args.message)}.`;
      case 'verifold_report_check': {
        const { id, checks } = await this.direction();
        const entry = await this.results.report(
          id,
          checks,
          await this.accepted(),
          { ...args, reason: why() },
        );
        return `Recorded check ${entry.check}: ${outcomeWords[entry.result]}.${entry.result === 'judgement' ? ' The person decides it.' : ''}`;
      }
      case 'verifold_propose_answer': {
        why();
        const { id } = await this.direction();
        await this.results.propose(id, await this.accepted(), args);
        return 'Recorded the answer. The person signs off.';
      }
      case 'verifold_compute':
        return this.describeCompute();
      case 'verifold_request_pod': {
        const lease = await this.pods().leases.request({
          by: 'coordinator',
          gpu: args.gpuType,
          hours: args.hours,
          tasks: args.tasks,
          reason: why(),
        });
        return `Asked the person for ${lease.id}: ${lease.gpu} for ${lease.hours} ${lease.hours === 1 ? 'hour' : 'hours'} at ${usd(lease.rate)} per hour. Nothing is created until the person approves it. An event tells you the decision.`;
      }
      case 'verifold_stop_pod': {
        const lease = await this.pods().leases.stop(
          args.lease,
          'coordinator',
          why(),
        );
        return `Stopped the pod of ${lease.id}. RunPod erased its disk. The lease stays open until ${lease.deadline ?? 'its end'}.`;
      }
      case 'verifold_start_pod': {
        const lease = await this.pods().leases.start(
          args.lease,
          'coordinator',
          why(),
        );
        return `Started the pod of ${lease.id} again. An event tells you when it is ready.`;
      }
      case 'verifold_end_lease': {
        const lease = await this.pods().leases.end(
          args.lease,
          'coordinator',
          why(),
        );
        return lease.state === 'denied'
          ? `Withdrew the request ${lease.id}.`
          : `Ended ${lease.id}. Verifold deleted its pod.`;
      }
      default:
        fail(`Verifold has no tool named ${name}.`);
    }
  }

  private pods(): Compute {
    return this.compute ?? fail('This Verifold has no compute owner.');
  }

  /** The pods part of the state: the person's limits, the budget, the leases, and the allowed GPUs now. */
  private async describeCompute(): Promise<string> {
    const compute = this.pods();
    const view = compute.view();
    const { settings, budget } = view;
    let offers: unknown;
    try {
      const catalog = await compute.catalog();
      offers = settings.gpuTypes.map((id) => {
        const offer = catalog.find((entry) => entry.id === id);
        return offer
          ? {
              gpuType: id,
              memoryGb: offer.memoryGb,
              usdPerHour: offer.price,
              stock: offer.stock,
            }
          : { gpuType: id, offered: false };
      });
    } catch (error) {
      offers = `unknown: ${error instanceof Error ? error.message : 'RunPod did not answer.'}`;
    }
    const now = Date.now();
    return JSON.stringify({
      podsOn: settings.limitUsd !== null && view.key !== null,
      limits: {
        spendLimitUsd: settings.limitUsd,
        maxUsdPerHourPerPod: settings.maxUsdPerHour,
        maxHoursPerLease: settings.maxHoursPerLease,
        idleMinutesBeforeStop: settings.idleMinutes,
        podsAtOnce: settings.maxRunningPods,
        diskGb: settings.diskGb,
        images: settings.images,
      },
      budget: {
        spentUsd: Number(budget.spent.toFixed(2)),
        heldUsd: Number(budget.reserved.toFixed(2)),
        leftUsd: budget.left === null ? null : Number(budget.left.toFixed(2)),
      },
      allowedGpus: offers,
      leases: view.leases.slice(-20).map((lease) => ({
        id: lease.id,
        state: lease.state,
        tasks: lease.tasks,
        gpuType: lease.gpu,
        usdPerHour: lease.rate,
        hours: lease.hours,
        endsAt: lease.deadline,
        costSoFarUsd: Number(spent(lease, now).toFixed(2)),
        ...(lease.end ? { ended: lease.end.reason } : {}),
      })),
    });
  }

  /** The person rules on a check that waits for their judgement. The coordinator reads it at its next wakeup. */
  ruleCheck(check: unknown, result: unknown, reason: unknown): Promise<void> {
    return this.serial(async () => {
      const { id, checks } = await this.direction();
      const entry = await this.results.rule(id, check, result, reason);
      if (entry.ruling)
        await this.tasks.post(
          'coordinator',
          `My ruling on check ${entry.check} (${checks[entry.check - 1] ?? ''}): ${outcomeWords[entry.ruling.result]}. ${entry.ruling.reason}`,
          'person',
        );
    });
  }

  /** The person accepts the answer, or asks for more work. The coordinator reads it at its next wakeup. */
  decideAnswer(kind: unknown, note: unknown): Promise<void> {
    return this.serial(async () => {
      const { id } = await this.direction();
      const answer = await this.results.decide(id, kind, note);
      await this.tasks.post(
        'coordinator',
        answer.decision?.kind === 'accepted'
          ? 'I accept the answer.'
          : `More work, please: ${answer.decision?.note ?? ''}`,
        'person',
      );
    });
  }

  /** The chosen direction and its checks. Results belong to it. */
  private async direction(): Promise<{
    readonly id: string;
    readonly checks: readonly string[];
  }> {
    const workspace = await loadWorkspace(this.root);
    const idea = workspace.candidates.find(
      (candidate) => candidate.id === workspace.selectedId,
    );
    return idea
      ? { id: idea.id, checks: idea.gates }
      : fail('No direction is chosen, so it has no checks.');
  }

  /** The project files that a person or the coordinator accepted from a task version. */
  private async accepted(): Promise<ReadonlySet<string>> {
    return new Set(
      (await this.tasks.list()).flatMap((task) =>
        (task.artifacts ?? []).flatMap((artifact) =>
          artifact.files.map((file) => file.path),
        ),
      ),
    );
  }

  /** The state that the coordinator reads: tasks, latest versions, open messages, and limits. */
  private async describe(): Promise<string> {
    const all = await this.tasks.list();
    const messages = await this.tasks.messageList();
    const state = this.current();
    const value = {
      objective: state.objective,
      limits: {
        workers: workerLimit,
        running: all.filter((task) =>
          ['claimed', 'running'].includes(task.state),
        ).length,
        tasksCreated: `${state.created} of ${coordinatorLimits.tasks}`,
      },
      tasks: all.map((task) => {
        const attempt = task.attempts.at(-1);
        const latest = attempt?.versions.at(-1);
        return {
          id: task.id,
          title: task.assignment.title,
          state: task.state,
          revision: task.revision,
          host: task.assignment.host,
          objective: task.assignment.objective.slice(0, 1000),
          writable: task.assignment.writable,
          output: task.assignment.output.slice(0, 500),
          dependencies: task.assignment.dependencies,
          acceptedVersions: (task.artifacts ?? []).map(
            (artifact) => artifact.version,
          ),
          received: attempt?.consumed ?? [],
          replacedInputs: replaced(attempt, all),
          ...(latest
            ? {
                latestVersion: {
                  number: latest.number,
                  turn: latest.turn,
                  decision: latest.decision,
                  files: latest.files.map((file) => ({
                    path: file.path,
                    change: file.change,
                    inScope: file.inScope,
                  })),
                  ...(latest.note ? { harness: latest.note } : {}),
                  ...(latest.reply
                    ? { workerReply: latest.reply.slice(0, 2000) }
                    : {}),
                },
              }
            : {}),
        };
      }),
      openMessages: messages
        .filter(
          (message) =>
            message.status === 'open' ||
            (message.to === 'coordinator' && message.delivery === 'queued'),
        )
        .slice(-50)
        .map((message) => ({
          id: message.id,
          from: message.from,
          to: message.to,
          kind: message.kind,
          status: message.status,
          about: message.about,
          text: message.text.slice(0, messageLimits.text),
          evidence: message.evidence,
        })),
      ...(await this.direction().then(
        ({ id, checks }) => {
          const results = this.results.read(id);
          return {
            checks: checks.map((text, index) => {
              const entry = results?.checks.find(
                (saved) => saved.check === index + 1,
              );
              return {
                check: index + 1,
                text,
                ...(entry
                  ? {
                      result: entry.result,
                      value: entry.value,
                      ...(entry.ruling ? { personRuling: entry.ruling } : {}),
                    }
                  : { result: 'not reported' }),
              };
            }),
            answer: results?.answer
              ? {
                  statement: results.answer.statement,
                  decision: results.answer.decision ?? 'waits for the person',
                }
              : null,
          };
        },
        () => ({}),
      )),
    };
    return JSON.stringify(value, null, 2).slice(0, 60_000);
  }

  private current(): CoordinatorState {
    return this.state ?? fail('No coordinator runs in this project.');
  }

  /** Run one change after the previous one ends. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async save(state: CoordinatorState): Promise<void> {
    this.state = state;
    const folder = join(this.root, '.verifold', 'coordinator');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = join(
      folder,
      `.state.${randomBytes(4).toString('hex')}.tmp`,
    );
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      } finally {
        await file.close();
      }
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** A check's outcome in words, for tool replies and messages. */
const outcomeWords = {
  passed: 'passed',
  failed: 'failed',
  partial: 'partly passed',
  judgement: "needs the person's judgement",
} as const;

const task = { type: 'string', description: 'A task ID, such as task-2' };
const reason = {
  type: 'string',
  maxLength: 2000,
  description: 'Why you take this action. The person reads it.',
};
const paths = { type: 'array', items: { type: 'string' }, maxItems: 20 };
const network = {
  type: 'object',
  description:
    "The domains that the task's shell commands may reach, for example to download a dataset, and why. Leave out for no network. An empty domain list removes it.",
  properties: {
    domains: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    reason: { type: 'string', maxLength: 500 },
  },
  required: ['domains', 'reason'],
  additionalProperties: false,
};
const inputs = {
  ...paths,
  description:
    'Files that exist in the project now. Do not list files from tasks that this task waits for: it receives them when it starts.',
};

const lease = {
  type: 'string',
  pattern: '^lease-[0-9]{1,6}$',
  description: 'A lease ID from verifold_compute',
};

/** The coordinator's tools. Each one calls the task operation that the person uses in the desk. */
const coordinatorToolSpecs: readonly AgentTool[] = [
  {
    name: 'verifold_compute',
    description:
      'Read the GPU pod limits that the person set, what is spent and held, each lease with its state and cost, and the allowed GPU types with their price and stock now.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_request_pod',
    description:
      'Ask the person for a GPU pod lease for tasks: one GPU of an allowed type, for a number of hours. Nothing is created or billed until the person approves it. Verifold refuses a request that does not fit the limits.',
    inputSchema: {
      type: 'object',
      properties: {
        gpuType: {
          type: 'string',
          description: 'An allowed GPU type ID from verifold_compute',
        },
        hours: { type: 'integer', minimum: 1, maximum: 24 },
        tasks: { type: 'array', items: task, minItems: 1, maxItems: 4 },
        reason,
      },
      required: ['gpuType', 'hours', 'tasks', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_stop_pod',
    description:
      'Stop the pod of a lease while no task needs it. RunPod erases its disk. The lease stays open until its end, so you can start the pod again.',
    inputSchema: {
      type: 'object',
      properties: { lease, reason },
      required: ['lease', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_start_pod',
    description: 'Start the stopped pod of an open lease again.',
    inputSchema: {
      type: 'object',
      properties: { lease, reason },
      required: ['lease', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_end_lease',
    description:
      'End a lease now: Verifold deletes its pod, and billing ends. A request that waits for the person is withdrawn.',
    inputSchema: {
      type: 'object',
      properties: { lease, reason },
      required: ['lease', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_state',
    description:
      'Read the objective, the tasks with their latest versions and worker replies, the open messages, and the limits.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_read',
    description:
      'Read one file of a task version, up to 64 KB of text, to review it.',
    inputSchema: {
      type: 'object',
      properties: {
        task,
        version: { type: 'integer' },
        path: { type: 'string' },
      },
      required: ['task', 'version', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_create_task',
    description:
      'Create a scoped task. It runs in its own copy of the project and can write only to its writable paths.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 120 },
        objective: { type: 'string', maxLength: 8000 },
        writable: paths,
        output: { type: 'string', maxLength: 2000 },
        inputs,
        dependencies: { type: 'array', items: task, maxItems: 20 },
        host: { type: 'string', enum: ['claude', 'codex'] },
        minutes: { type: 'integer', minimum: 1, maximum: 240 },
        network,
        reason,
      },
      required: ['title', 'objective', 'writable', 'output', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_revise_task',
    description:
      'Make a new revision of an open or done task. Give only the fields that change. A done task opens again.',
    inputSchema: {
      type: 'object',
      properties: {
        task,
        title: { type: 'string', maxLength: 120 },
        objective: { type: 'string', maxLength: 8000 },
        writable: paths,
        output: { type: 'string', maxLength: 2000 },
        inputs,
        dependencies: { type: 'array', items: task, maxItems: 20 },
        host: { type: 'string', enum: ['claude', 'codex'] },
        minutes: { type: 'integer', minimum: 1, maximum: 240 },
        network,
        reason,
      },
      required: ['task', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_start_task',
    description: 'Start an open task in a free worker slot.',
    inputSchema: {
      type: 'object',
      properties: { task, reason },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_stop_task',
    description:
      'Stop the running turn of a task. Its work becomes a version for review.',
    inputSchema: {
      type: 'object',
      properties: { task, reason },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_accept',
    description:
      'Accept the latest version of a task. Its files inside the writable paths reach the project, and the tasks that wait for it receive them.',
    inputSchema: {
      type: 'object',
      properties: {
        task,
        version: { type: 'integer' },
        files: {
          ...paths,
          description:
            'Leave out to accept every file inside the writable paths.',
        },
        reason,
      },
      required: ['task', 'version', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_request_changes',
    description:
      'Ask the worker for changes to the latest version. The next version follows.',
    inputSchema: {
      type: 'object',
      properties: { task, note: { type: 'string', maxLength: 4000 } },
      required: ['task', 'note'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_reject',
    description:
      'Reject the latest version. The task opens again for a new attempt or a revision.',
    inputSchema: {
      type: 'object',
      properties: { task, version: { type: 'integer' }, reason },
      required: ['task', 'version', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_cancel_task',
    description: 'Cancel an open task, or a task in review with its version.',
    inputSchema: {
      type: 'object',
      properties: { task, reason },
      required: ['task', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_post',
    description:
      'Send a note to a task (its worker receives it with its next turn) or to the person.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'A task ID, or "person"' },
        text: { type: 'string', maxLength: 4000 },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_decide',
    description:
      'Settle an open objection (upheld or overruled) or blocker (resolved), with a reason. The decision goes to the task that raised it.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message ID, such as m-4' },
        decision: { type: 'string', enum: ['upheld', 'overruled', 'resolved'] },
        reason,
      },
      required: ['message', 'decision', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_report_check',
    description:
      "Report the result of one check of the chosen direction, with the accepted files that show it. Use judgement when only the person can decide, and ask them one question. The person's ruling is final.",
    inputSchema: {
      type: 'object',
      properties: {
        check: {
          type: 'integer',
          minimum: 1,
          description: 'The check number from verifold_state',
        },
        result: {
          type: 'string',
          enum: ['passed', 'failed', 'partial', 'judgement'],
        },
        value: {
          type: 'string',
          maxLength: 500,
          description:
            'What the evidence shows, for example "0 mismatches in 1,800 queries" or "7 of 9 groups pass"',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 10,
          description: 'Accepted project files that show the result',
        },
        question: {
          type: 'string',
          maxLength: 500,
          description:
            'For judgement only: the question that the person decides',
        },
        reason,
      },
      required: ['check', 'result', 'value', 'evidence', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_propose_answer',
    description:
      'Propose the answer to the objective when the checks have results: a short statement, and the claims that support it with their evidence. The person signs off.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', maxLength: 2000 },
        claims: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', maxLength: 500 },
              evidence: {
                type: 'array',
                items: { type: 'string' },
                maxItems: 10,
                description: 'Accepted project files or web addresses',
              },
            },
            required: ['text', 'evidence'],
            additionalProperties: false,
          },
        },
        reason,
      },
      required: ['statement', 'claims', 'reason'],
      additionalProperties: false,
    },
  },
];
