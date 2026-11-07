import { useCallback, useEffect, useRef, useState } from 'react';

import type { Api } from '../api/client.ts';
import { watchChanges } from '../api/events.ts';
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

/** Return the lab as the server has it now, and a function that reads it again at once. */
export function useLab(api: Api, token: string): LabData & { readonly reload: () => void } {
  const [data, setData] = useState<LabData>(EMPTY);
  const latest = useRef(0);

  const reload = useCallback((): void => {
    // A slow response must not overwrite a newer one, so only the latest load applies.
    const ticket = ++latest.current;
    readLab(api).then(
      (read) => {
        if (ticket === latest.current) setData((old) => ({ ...read, version: old.version + 1 }));
      },
      (error: unknown) => {
        if (ticket === latest.current) setData((old) => ({ ...old, error: messageOf(error) }));
      },
    );
  }, [api]);

  useEffect(() => {
    reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = watchChanges(token, () => {
      clearTimeout(timer);
      timer = setTimeout(reload, SETTLE);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [reload, token]);

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
