import { researchRunOnDisk } from './history.ts';
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
  'A lab works on this run. Start over in the app to use research and the coordinator on a new run.';

/** Why a lab cannot start: the run is from the research flow that came before the lab. */
export const researchRunWorks =
  "This project's current run is from the research flow that came before the lab. Open History in the app and choose Start a lab: it archives that run first.";

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
    /** The project folder. A lab start also reads its records for a research-flow run. */
    readonly root?: string;
  };

  constructor(owners: RunTeam['owners']) {
    this.owners = owners;
  }

  /**
   * Why a team, or research, cannot start on the run now, or null. Only a lab
   * start reads the coordinator's records: the others need only the lab's.
   */
  async refusal(kind: TeamKind | 'research'): Promise<string | null> {
    if (kind !== 'lab') return this.owners.lab() ? labWorks : null;
    if (this.owners.lab()) return 'The lab already runs.';
    if (
      (await this.owners.coordinator()) ||
      (this.owners.root !== undefined &&
        (await researchRunOnDisk(this.owners.root)))
    )
      return researchRunWorks;
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
