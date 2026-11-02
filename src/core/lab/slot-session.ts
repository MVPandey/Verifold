/**
 * One short session beside a lab's agents, such as a long-shot judge or a
 * Coordinator's update. It holds what such a session needs and no domain rule:
 * its start, its time limit, its tools, the end of each turn, and its end. A
 * domain file says what the session owes and what its tools do. The session
 * owns its timer, so `end` is its only stop path.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessName } from '../harness.ts';
import type { SessionRecord } from '../session.ts';
import type { AgentTool, AgentTools } from '../session-hosts.ts';
import { PoolFullError } from '../workers.ts';
import { fail, type LabSessions, type labTiming } from './schema.ts';
import { stoppedText } from './words.ts';

/** What a slot session needs of the lab. */
export interface SlotHost {
  readonly root: string;
  readonly sessions: Pick<
    LabSessions,
    'view' | 'startAgent' | 'continueTask' | 'endTask'
  >;
  readonly timing: Pick<typeof labTiming, 'minuteMs'>;
  /** The lab's queue. */
  serial<T>(work: () => T | Promise<T>): Promise<T>;
}

/** Why a session ended by itself. `done`: it owes nothing. `time`, `turns`: it used up a limit. `exit`: its process stopped. */
export type SlotEnd = 'done' | 'time' | 'turns' | 'exit';

/** One session's work. */
export interface SlotJob {
  /** The agent ID that its record holds. */
  readonly agent: string;
  readonly host: HarnessName;
  /** Its folder under `.verifold/checks`. */
  readonly folder: string;
  readonly specs: readonly AgentTool[];
  readonly turns: number;
  readonly minutes: number;
  /** It acts only through `specs`, with no shell and no file tools of its own. */
  readonly toolsOnly?: boolean;
  prompt(): Promise<string>;
  model(): Promise<string | null>;
  /** What it cannot read. */
  denied(): Promise<readonly string[]>;
  /** One tool call, in the lab's queue. Throws a refusal that the session reads. */
  call(name: string, input: unknown): string | Promise<string>;
  /** What the session still owes, as words for its next turn, or null. */
  owed(): string | null;
  /** The session ended by itself, in the lab's queue. `end` does not call this. */
  ended(how: SlotEnd): void | Promise<void>;
}

export class SlotSession {
  private session: string | null = null;
  private turns = 0;
  private timer: NodeJS.Timeout | undefined;
  private over = false;
  private readonly host: SlotHost;
  private readonly job: SlotJob;

  constructor(host: SlotHost, job: SlotJob) {
    this.host = host;
    this.job = job;
  }

  /**
   * Make its folder and start it. False: another start took the slot, so
   * nothing ran. Any other failure throws.
   */
  async start(): Promise<boolean> {
    const { host, job } = this;
    const folder = join(host.root, '.verifold', 'checks', job.folder);
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const model = await job.model();
      this.session = await host.sessions.startAgent({
        host: job.host,
        ...(model ? { model } : {}),
        prompt: await job.prompt(),
        cwd: folder,
        agent: job.agent,
        tools: this.tools(),
        denyRead: [...(await job.denied())],
        side: true,
        ...(job.toolsOnly ? { toolsOnly: true } : {}),
      });
    } catch (error) {
      if (error instanceof PoolFullError) return false;
      throw error;
    }
    this.timer = setTimeout(
      () => void host.serial(() => this.finish('time')).catch(() => {}),
      job.minutes * host.timing.minuteMs,
    );
    this.timer.unref();
    return true;
  }

  /** The tools of the session. A call after its end changes nothing. */
  private tools(): AgentTools {
    return {
      specs: this.job.specs,
      call: async (name, input) => {
        try {
          return {
            ok: true,
            text: await this.host.serial(() => {
              if (this.over) fail(stoppedText);
              return this.job.call(name, input);
            }),
          };
        } catch (error) {
          return {
            ok: false,
            text:
              error instanceof Error
                ? error.message
                : 'Verifold could not do this.',
          };
        }
      },
    };
  }

  /** A turn ended, or its process stopped. */
  turnEnded(record: SessionRecord): void {
    void this.host.serial(() => this.afterTurn(record)).catch(() => {});
  }

  private async afterTurn(record: SessionRecord): Promise<void> {
    if (this.over || (this.session && this.session !== record.id)) return;
    this.session ??= record.id;
    const owed = this.job.owed();
    if (owed === null) return this.finish('done');
    if (record.status !== 'idle') {
      if (
        record.status === 'ended' ||
        record.status === 'failed' ||
        record.status === 'paused'
      )
        await this.finish('exit');
      return;
    }
    this.turns += 1;
    if (this.turns >= this.job.turns) return this.finish('turns');
    this.host.sessions.continueTask(record.id, owed);
  }

  private async finish(how: SlotEnd): Promise<void> {
    if (this.over) return;
    this.end();
    await this.job.ended(how);
  }

  /** Stop the session and its timer. Tool calls of it change nothing from now on. */
  end(): void {
    clearTimeout(this.timer);
    this.over = true;
    const { sessions } = this.host;
    if (this.session && sessions.view(this.session)?.live)
      try {
        sessions.endTask(this.session, 'Its work ended.');
      } catch {
        /* The session ends with the next stop of its process. */
      }
  }
}
