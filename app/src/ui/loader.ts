import { messageOf } from '../api/client.ts';
import type { Api } from '../api/client.ts';
import type { LabView, PostView, SetupView, ThreadSummary } from '../api/types.ts';

/** What the app knows about the folder's lab. */
export interface LabData {
  readonly setup: SetupView | null;
  readonly lab: LabView | null;
  readonly threads: readonly ThreadSummary[];
  readonly needs: readonly PostView[];
  /** The newest report for the person, or `null` when no agent has posted one. */
  readonly report: PostView | null;
  /** Rises with each full load, so a page that reads more of the lab can read it again. */
  readonly version: number;
  readonly error: string | null;
}

export const EMPTY: LabData = {
  setup: null,
  lab: null,
  threads: [],
  needs: [],
  report: null,
  version: 0,
  error: null,
};

export const LOST =
  'Lost the connection to verifold. The page reconnects when verifold is back. If you restarted verifold, open the new link that it printed.';

/** Takes a function from the old data to the new data, as a React state setter does. */
export type Apply = (update: (old: LabData) => LabData) => void;

/** Reads the lab from the server, and keeps the reads in order. */
export interface Loader {
  /** Read the whole lab: the setup, the lab view, the threads, the asks to the person, and the newest report. */
  readonly full: () => void;
  /** Read only the lab view, which holds what each agent is doing. */
  readonly activity: () => void;
  /** Whether the last full read failed. Until one succeeds, every read is a full one. */
  readonly stale: () => boolean;
  /** The event stream dropped. The error shows `LOST` until `back`. */
  readonly lose: () => void;
  /** The event stream is back. Read the whole lab again. */
  readonly back: () => void;
}

/**
 * Return a loader that reads from `api` and passes each result to `apply`.
 *
 * Only the latest read applies, so a slow response never overwrites a newer one. An activity read that comes
 * during a full read waits for it and then reads the lab view again, because the full read may have read the lab
 * view before the change.
 */
export function createLoader(api: Api, apply: Apply): Loader {
  let latest = 0;
  let fullReading = false;
  let activityAgain = false;
  let failed = false;
  let labOpen = false;
  let lost = false;

  const fail = (error: unknown): void => {
    apply((old) => ({ ...old, error: lost ? LOST : messageOf(error) }));
  };

  const full = (): void => {
    const ticket = ++latest;
    fullReading = true;
    activityAgain = false;
    readLab(api).then(
      (read) => {
        if (ticket !== latest) return;
        fullReading = false;
        failed = false;
        labOpen = read.lab !== null;
        apply((old) => ({ ...read, error: lost ? LOST : null, version: old.version + 1 }));
        if (activityAgain) activity();
      },
      (error: unknown) => {
        if (ticket !== latest) return;
        fullReading = false;
        failed = true;
        fail(error);
      },
    );
  };

  const activity = (): void => {
    if (fullReading) {
      activityAgain = true;
      return;
    }
    // Before the folder has a lab there is no lab view, and after a failed full read the rest is stale too.
    if (failed || !labOpen) {
      full();
      return;
    }
    const ticket = ++latest;
    api.lab().then(
      (lab) => {
        if (ticket === latest) apply((old) => ({ ...old, lab, error: lost ? LOST : null }));
      },
      (error: unknown) => {
        if (ticket === latest) fail(error);
      },
    );
  };

  return {
    full,
    activity,
    stale: () => failed,
    lose: () => {
      lost = true;
      apply((old) => ({ ...old, error: LOST }));
    },
    back: () => {
      lost = false;
      full();
    },
  };
}

async function readLab(api: Api): Promise<Omit<LabData, 'version'>> {
  const setup = await api.setup();
  if (setup.question === null) return { ...EMPTY, setup };
  const [lab, threads, needs, report] = await Promise.all([
    api.lab(),
    api.threads(),
    api.needs(),
    api.report(),
  ]);
  return { setup, lab, threads, needs, report, error: null };
}
