import { useEffect, useMemo, useState } from 'react';

import type { Api } from '../api/client.ts';
import { watchChanges } from '../api/events.ts';
import type { Change } from '../api/events.ts';
import { messageOf } from '../api/client.ts';
import type { LabView, ThreadView } from '../api/types.ts';
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

/** A thread as the server has it, or the reason that the read failed. */
export interface ThreadRead {
  readonly view: ThreadView | null;
  readonly error: string | null;
}

/** Return thread `id` and read it again at each full load of the lab. `null` reads nothing. */
export function useThread(api: Api, id: string | null, version: number): ThreadRead {
  const [read, setRead] = useState<(ThreadRead & { readonly id: string }) | null>(null);
  useEffect(() => {
    if (id === null) return;
    let current = true;
    api.thread(id).then(
      (view) => {
        if (current) setRead({ id, view, error: null });
      },
      (failure: unknown) => {
        // A failed read keeps the thread that the page already shows.
        if (current) {
          setRead((old) => ({
            id,
            view: old?.id === id ? old.view : null,
            error: messageOf(failure),
          }));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [api, id, version]);
  return read?.id === id ? read : { view: null, error: null };
}

/** Return the page that the URL fragment names, and follow changes to it. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    // An open thread is part of the lab page, so opening or closing one keeps the page where it is.
    const place = (page: Route['page']): string => (page === 'thread' ? 'lab' : page);
    let last = place(parseRoute(window.location.hash).page);
    const follow = (): void => {
      const next = parseRoute(window.location.hash);
      setRoute(next);
      if (place(next.page) !== last) window.scrollTo(0, 0);
      last = place(next.page);
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
