import { messageOf } from '../api/client.ts';
import type { Api } from '../api/client.ts';
import type {
  AnswerView,
  ConversationView,
  LabView,
  PostView,
  SetupView,
  ThreadSummary,
} from '../api/types.ts';

/** What the app knows about the folder's lab. */
export interface LabData {
  readonly setup: SetupView | null;
  readonly lab: LabView | null;
  readonly threads: readonly ThreadSummary[];
  readonly needs: readonly PostView[];
  /** The newest report for the person, or `null` when no agent has posted one. */
  readonly report: PostView | null;
  /** The lab's answer so far with what it builds on, or `null` when no agent has proposed one. */
  readonly answer: AnswerView | null;
  /** The conversation with the coordinator, its powers, and what it did for the person. `null` before a lab starts. */
  readonly conversation?: ConversationView | null;
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
  answer: null,
  conversation: null,
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
  const [lab, threads, needs, report, answer, conversation] = await Promise.all([
    api.lab(),
    api.threads(),
    api.needs(),
    api.report(),
    api.answer(),
    api.conversation(),
  ]);
  return { setup, lab, threads, needs, report, answer, conversation, error: null };
}

/**
 * Return a function that numbers each read of one thread. The function that it returns says, when the read's
 * answer comes, whether no later read has shown a thread yet. With `shown`, it then counts this answer as shown.
 *
 * So a read that the next load overtakes still shows when it answers first. In a busy lab the loads follow each
 * other faster than a long thread reads, and dropping every overtaken read would leave the thread as it was. A
 * failed read passes `shown` as `false`: its error shows, and an earlier read that then succeeds replaces it.
 */
export function inOrder(): () => (shown: boolean) => boolean {
  let started = 0;
  let last = 0;
  return () => {
    const ticket = ++started;
    return (shown) => {
      if (ticket < last) return false;
      if (shown) last = ticket;
      return true;
    };
  };
}

/**
 * Return a function that runs `run` once the calls to it stop for `quiet` milliseconds, and at the latest `most`
 * milliseconds after the first call that waits. So a burst of changes causes one read, and a steady stream of
 * them cannot postpone every read. `stop` drops a run that waits.
 */
export function settled(
  run: () => void,
  quiet: number,
  most: number,
): { readonly poke: () => void; readonly stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let since: number | null = null;
  return {
    poke: () => {
      const now = Date.now();
      since ??= now;
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          since = null;
          run();
        },
        Math.max(0, Math.min(quiet, since + most - now)),
      );
    },
    stop: () => {
      clearTimeout(timer);
    },
  };
}
