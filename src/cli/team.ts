import { SessionActionError } from './session.ts';

/**
 * One run has one team: the coordinator's team (research, the coordinator,
 * and its tasks) or a lab. The guard keeps no state of its own. It asks the
 * owners of the records each time: the lab, the coordinator, the tasks, and
 * research. Every start of either team, and every research start, checks
 * and makes its change under one lock, so no other start comes between the
 * check and the change. Research alone does not take the run, but a lab
 * does not start while research works.
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
  private lock: Promise<unknown> = Promise.resolve();
  private readonly owners: {
    /** A lab exists. */
    readonly lab: () => boolean;
    /** A coordinator record or a task exists. */
    readonly coordinator: () => Promise<boolean>;
    /** A research step runs, checks its input, or chooses a direction. */
    readonly researchBusy: () => boolean;
  };

  constructor(owners: RunTeam['owners']) {
    this.owners = owners;
  }

  /** The team that works on the run now, from the owners' records. */
  async team(): Promise<TeamKind | null> {
    if (this.owners.lab()) return 'lab';
    return (await this.owners.coordinator()) ? 'coordinator' : null;
  }

  /** Why a team, or research, cannot start on the run now, or null. */
  async refusal(kind: TeamKind | 'research'): Promise<string | null> {
    const team = await this.team();
    if (kind !== 'lab') return team === 'lab' ? labWorks : null;
    if (team === 'lab') return 'The lab already runs.';
    if (team === 'coordinator') return coordinatorWorks;
    return this.owners.researchBusy() ? researchRuns : null;
  }

  /**
   * Check and change the run in one step: `work` runs under the run's lock
   * after the check passed. A start holds the lock only while it makes the
   * change that the check looks at, such as the record that takes the run,
   * so a start never waits for another start's harness.
   */
  exclusive<T>(
    kind: TeamKind | 'research',
    work: () => T | Promise<T>,
  ): Promise<T> {
    const run = this.lock.then(async () => {
      const refused = await this.refusal(kind);
      if (refused) throw new SessionActionError(refused);
      return work();
    });
    this.lock = run.catch(() => {});
    return run;
  }
}
