/**
 * Each agent's helpers, in `.verifold/lab/helpers.json`. The store keeps them
 * in memory, read once at load, and applies the pure rules of helpers.ts. A
 * harness event changes memory in one synchronous step, so events need no
 * queue. A harness can write in the project, so the file is parsed with care.
 */
import { readingLimits } from '../lab-tools.ts';
import { helperEvent, type TranscriptUpdate } from '../transcript.ts';
import {
  afterProcess,
  helpersAfter,
  lostLine,
  parseHelper,
} from './helpers.ts';
import {
  agentEntries,
  putAgent,
  readObject,
  RecordFile,
} from './record-file.ts';
import type { Helper } from './schema.ts';

export class HelperStore {
  private helpers = new Map<string, readonly Helper[]>();
  private readonly path: string;
  private readonly file: RecordFile;

  /** `paused`: the lab's records moved, so nothing writes until the next load. */
  constructor(path: string, paused: () => boolean) {
    this.path = path;
    this.file = new RecordFile(path, () =>
      paused()
        ? null
        : {
            schemaVersion: 1,
            helpers: [...this.helpers].map(([agent, helpers]) => ({
              agent,
              helpers,
            })),
          },
    );
  }

  /** Read the records. `on`: a lab with threads. Any other lab holds none. */
  async load(on: boolean): Promise<void> {
    const saved = on ? await readObject(this.path) : null;
    this.helpers = agentEntries(saved?.helpers, (entry) =>
      (Array.isArray(entry.helpers) ? entry.helpers : [])
        .flatMap((item) => parseHelper(item) ?? [])
        .slice(-readingLimits.helpers),
    );
  }

  /** Wait until the newest records are on disk. */
  flush(): Promise<void> {
    return this.file.flush();
  }

  /** One update of a harness, from the process `launch` of an agent named `handle`. A failed save comes again with the next one. */
  heard(
    agent: string,
    handle: string,
    launch: string,
    update: TranscriptUpdate,
    at: string,
  ): void {
    const event = helperEvent(update);
    if (!event) return;
    const helpers = this.helpersOf(agent);
    const next = helpersAfter(helpers, event, handle, launch, at);
    if (next === helpers) return;
    putAgent(this.helpers, agent, next);
    void this.file.save().catch(() => {});
  }

  /** An agent's helpers, oldest first. */
  helpersOf(agent: string): readonly Helper[] {
    return this.helpers.get(agent) ?? [];
  }

  /** A helper of the agent runs now. */
  helping(agent: string): boolean {
    return this.helpersOf(agent).some((helper) => helper.state === 'running');
  }

  /**
   * Mark the helpers of a process that ended as lost, and give `tell` the line
   * of each lost helper that its agent has not heard of. `live`: the process
   * of an agent that runs now. `tell` returns whether the line reached the
   * agent: a line that did not comes again.
   */
  sweep(
    live: (agent: string) => string | null,
    tell: (agent: string, line: string) => boolean,
  ): void {
    const at = new Date().toISOString();
    for (const [agent, helpers] of this.helpers) {
      if (!helpers.some((helper) => helper.state !== 'done' && !helper.told))
        continue;
      const after = afterProcess(helpers, live(agent), at).map((helper) =>
        helper.state === 'lost' && !helper.told && tell(agent, lostLine(helper))
          ? { ...helper, told: true as const }
          : helper,
      );
      if (after.some((helper, index) => helper !== helpers[index])) {
        this.helpers.set(agent, after);
        void this.file.save().catch(() => {});
      }
    }
  }
}
