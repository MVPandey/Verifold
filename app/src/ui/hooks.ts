import { useEffect, useMemo, useState } from 'react';

import type { Api } from '../api/client.ts';
import { watchChanges } from '../api/events.ts';
import type { Change } from '../api/events.ts';
import type { LabView } from '../api/types.ts';
import { parseRoute } from '../model/route.ts';
import type { Route } from '../model/route.ts';
import { EMPTY, createLoader } from './loader.ts';
import type { LabData } from './loader.ts';

/** What each page of a started lab gets: the API, the lab, and the current time. */
export interface PageProps {
  readonly api: Api;
  readonly data: LabData & { readonly lab: LabView; readonly reload: () => void };
  readonly now: Date;
}

/** Milliseconds to wait after a change, so a burst of changes causes one read. */
const SETTLE = 150;

/**
 * Return the lab as the server has it now, and a function that reads all of it again at once.
 *
 * A new event on the board reads the whole lab again. A change in what agents are doing reads only the lab view,
 * which holds each agent's activity.
 */
export function useLab(api: Api, token: string): LabData & { readonly reload: () => void } {
  const [data, setData] = useState<LabData>(EMPTY);
  const loader = useMemo(() => createLoader(api, setData), [api]);

  useEffect(() => {
    loader.full();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let full = false;
    let last: Change | null = null;
    const schedule = (needsFull: boolean): void => {
      full ||= needsFull;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (full) loader.full();
        else loader.activity();
        full = false;
      }, SETTLE);
    };
    const stop = watchChanges(token, {
      onChange: (change) => {
        const board = last === null || change.seq !== last.seq;
        const activity = last === null || change.activity !== last.activity;
        last = change;
        // A heartbeat with no change reads nothing, unless the last full read failed and must run again.
        if (board || activity || loader.stale()) schedule(board);
      },
      onLost: loader.lose,
      onBack: () => {
        last = null;
        loader.back();
      },
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [loader, token]);

  return { ...data, reload: loader.full };
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
