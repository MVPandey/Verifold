import { useCallback, useEffect, useRef, useState } from 'react';

import type { Api } from '../api/client.ts';
import { watchChanges } from '../api/events.ts';
import type { Change } from '../api/events.ts';
import type { LabView, PostView, SetupView, ThreadSummary } from '../api/types.ts';
import { parseRoute } from '../model/route.ts';
import type { Route } from '../model/route.ts';

/** What the app knows about the folder's lab. */
export interface LabData {
  readonly setup: SetupView | null;
  readonly lab: LabView | null;
  readonly threads: readonly ThreadSummary[];
  readonly needs: readonly PostView[];
  /** Rises with each load, so a page that reads more of the lab can read it again. */
  readonly version: number;
  readonly error: string | null;
}

/** What each page of a started lab gets: the API, the lab, and the current time. */
export interface PageProps {
  readonly api: Api;
  readonly data: LabData & { readonly lab: LabView; readonly reload: () => void };
  readonly now: Date;
}

const EMPTY: LabData = { setup: null, lab: null, threads: [], needs: [], version: 0, error: null };

/** Milliseconds to wait after a change, so a burst of changes causes one load. */
const SETTLE = 150;

const LOST =
  'Lost the connection to verifold. The page reconnects when verifold is back. If you restarted verifold, open the new link that it printed.';

/**
 * Return the lab as the server has it now, and a function that reads all of it again at once.
 *
 * A new event on the board reads the whole lab again. A change in what agents are doing reads only the lab view,
 * which holds each agent's activity.
 */
export function useLab(api: Api, token: string): LabData & { readonly reload: () => void } {
  const [data, setData] = useState<LabData>(EMPTY);
  // A slow response must not overwrite a newer one, so only the latest load applies.
  const latest = useRef(0);
  const fullLoad = useRef(false);
  const hasLab = useRef(false);

  const reload = useCallback((): void => {
    const ticket = ++latest.current;
    fullLoad.current = true;
    readLab(api).then(
      (read) => {
        if (ticket !== latest.current) return;
        fullLoad.current = false;
        hasLab.current = read.lab !== null;
        setData((old) => ({ ...read, version: old.version + 1 }));
      },
      (error: unknown) => {
        if (ticket !== latest.current) return;
        fullLoad.current = false;
        setData((old) => ({ ...old, error: messageOf(error) }));
      },
    );
  }, [api]);

  const reloadActivity = useCallback((): void => {
    // A full load that is on its way brings the activity too.
    if (fullLoad.current) return;
    const ticket = ++latest.current;
    api.lab().then(
      (lab) => {
        if (ticket === latest.current) setData((old) => ({ ...old, lab, error: null }));
      },
      (error: unknown) => {
        if (ticket === latest.current) setData((old) => ({ ...old, error: messageOf(error) }));
      },
    );
  }, [api]);

  useEffect(() => {
    reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let full = false;
    let last: Change | null = null;
    const schedule = (needsFull: boolean): void => {
      full ||= needsFull;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (full) reload();
        else reloadActivity();
        full = false;
      }, SETTLE);
    };
    const stop = watchChanges(token, {
      onChange: (change) => {
        const board = last === null || change.seq !== last.seq;
        const activity = last === null || change.activity !== last.activity;
        last = change;
        // The stream also sends a heartbeat when nothing changed. That one reads nothing.
        if (board || activity) schedule(board || !hasLab.current);
      },
      onLost: () => {
        setData((old) => ({ ...old, error: LOST }));
      },
      onBack: () => {
        last = null;
        reload();
      },
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [reload, reloadActivity, token]);

  return { ...data, reload };
}

/** Return the page that the URL fragment names, and follow changes to it. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const follow = (): void => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', follow);
    return () => {
      window.removeEventListener('hashchange', follow);
    };
  }, []);
  return route;
}

/** Return the current time, updated every 30 seconds, for "2 min ago" text. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

/** Return the text of an error, for the person to read. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Reload the page.';
}

async function readLab(api: Api): Promise<Omit<LabData, 'version'>> {
  const setup = await api.setup();
  if (setup.question === null) return { ...EMPTY, setup };
  const [lab, threads, needs] = await Promise.all([api.lab(), api.threads(), api.needs()]);
  return { setup, lab, threads, needs, error: null };
}
