import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionActionError } from './session.ts';

/**
 * One run has one team: the coordinator's team (research, the coordinator,
 * and its tasks) or a lab. The project owner keeps one guard for its run, and
 * every start of either team asks it. A claim checks and takes the run in one
 * synchronous step, so two starts can never both pass. Research alone does
 * not take the run, but a lab does not start while a research step runs.
 */

export type TeamKind = 'lab' | 'coordinator';

/** Why research, the coordinator, or a task cannot work: a lab works on the run. */
export const labWorks =
  'A lab works on this run. Start over in Records to use research and the coordinator on a new run.';

const coordinatorWorks =
  "This run belongs to the coordinator's team. Start over in Records, then start the lab on the new run.";

const researchRuns =
  'Research is running. Wait for its step to end, or cancel it in Research, then start the lab.';

export class RunTeam {
  private kind: TeamKind | null = null;
  private readonly options: {
    /** A research step runs, or checks its input before it starts. */
    readonly researchBusy: () => boolean;
    /** The run's team as its records say: after a load, Start over, or a restore. */
    readonly read: () => Promise<TeamKind | null>;
  };

  constructor(options: RunTeam['options']) {
    this.options = options;
  }

  /** The team that works on the run, or null. */
  get team(): TeamKind | null {
    return this.kind;
  }

  /** Read the run's team from its records again. */
  async reload(): Promise<void> {
    this.kind = await this.options.read();
  }

  /** Why a team cannot work on the run now, or null. */
  refusal(kind: TeamKind): string | null {
    if (kind === 'coordinator') return this.kind === 'lab' ? labWorks : null;
    if (this.kind === 'lab') return 'The lab already runs.';
    if (this.kind === 'coordinator') return coordinatorWorks;
    return this.options.researchBusy() ? researchRuns : null;
  }

  /**
   * Take the run for a team, or throw why not. The returned function gives
   * the run back, for a start that fails before it changed anything. A claim
   * of the team that owns the run already gives nothing back.
   */
  claim(kind: TeamKind): () => void {
    const refused = this.refusal(kind);
    if (refused) throw new SessionActionError(refused);
    if (this.kind === kind) return () => {};
    this.kind = kind;
    return () => {
      if (this.kind === kind) this.kind = null;
    };
  }
}

/** Whether the project's current run has a lab, from its records. For CLI commands that run without the owner. */
export async function labOnDisk(root: string): Promise<boolean> {
  return (
    (await lstat(join(root, '.verifold', 'lab.json')).catch(() => null)) !==
    null
  );
}
