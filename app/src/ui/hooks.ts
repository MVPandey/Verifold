import { useEffect, useMemo, useRef, useState } from 'react';

import type { Api } from '../api/client.ts';
import { watchChanges } from '../api/events.ts';
import type { Change } from '../api/events.ts';
import { messageOf } from '../api/client.ts';
import type { DashboardPage, LabView, ThreadView } from '../api/types.ts';
import { parseRoute } from '../model/route.ts';
import type { Route } from '../model/route.ts';
import type { SeenStore } from '../model/seen.ts';
import { EMPTY, createLoader, inOrder, settled } from './loader.ts';
import type { LabData } from './loader.ts';

/** What each page of a started lab gets: the API, the lab, and the current time. */
export interface PageProps {
  readonly api: Api;
  readonly data: LabData & { readonly lab: LabView; readonly reload: () => void };
  readonly now: Date;
}

/**
 * The browser's storage for what the person has seen and chosen. A browser can refuse storage: the access to
 * `localStorage` itself then throws, and so does a write to a full store. Here a read then gives nothing and a
 * write keeps nothing, so no page fails for it.
 */
export const browserStore: SeenStore = {
  getItem: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // The page still has what it holds until it loads again.
    }
  },
};

/** Milliseconds to wait after a change, so a burst of changes causes one read. */
const SETTLE = 150;
/** The longest that a read waits for the changes to stop, in milliseconds. */
const MOST = 1_000;

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
    let full = false;
    let last: Change | null = null;
    const read = settled(
      () => {
        if (full) loader.full();
        else loader.activity();
        full = false;
      },
      SETTLE,
      MOST,
    );
    const schedule = (needsFull: boolean): void => {
      full ||= needsFull;
      read.poke();
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
      read.stop();
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
  const order = useMemo(() => inOrder(), []);
  const wanted = useRef(id);
  useEffect(() => {
    wanted.current = id;
    if (id === null) return;
    const newest = order();
    // An answer for a thread that the page left is dropped.
    const shows = (shown: boolean): boolean => wanted.current === id && newest(shown);
    api.thread(id).then(
      (view) => {
        if (shows(true)) setRead({ id, view, error: null });
      },
      (failure: unknown) => {
        // A failed read keeps the thread that the page already shows.
        if (shows(false)) {
          setRead((old) => ({
            id,
            view: old?.id === id ? old.view : null,
            error: messageOf(failure),
          }));
        }
      },
    );
  }, [api, id, version, order]);
  return read?.id === id ? read : { view: null, error: null };
}

/** The version of the dashboard that stands, with its page, as the server has it, or the reason that the read failed. */
export interface DashboardRead {
  readonly page: DashboardPage | null;
  readonly error: string | null;
}

/**
 * Return the version of the dashboard that stands, and read it again only when another version stands. `null`
 * reads nothing. So the agents' page keeps its place while the rest of the lab changes.
 */
export function useDashboard(api: Api, post: string | null): DashboardRead {
  const [read, setRead] = useState<(DashboardRead & { readonly post: string }) | null>(null);
  const wanted = useRef(post);
  useEffect(() => {
    wanted.current = post;
    if (post === null) return;
    api.dashboard().then(
      (page) => {
        if (wanted.current === post) setRead({ post, page, error: null });
      },
      (failure: unknown) => {
        if (wanted.current === post) setRead({ post, page: null, error: messageOf(failure) });
      },
    );
  }, [api, post]);
  return read?.post === post ? read : { page: null, error: null };
}

/** Return the page that the URL fragment names, and follow changes to it. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    // An open thread and the Dashboard tab are part of the lab page, so opening one keeps the page where it is.
    const place = (page: Route['page']): string =>
      page === 'thread' || page === 'dashboard' ? 'lab' : page;
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
