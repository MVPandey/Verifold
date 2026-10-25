import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetupView } from '../protocol/api.ts';
import type { SetupActions } from './setup.ts';

/** How often the page reads the first run again while Verifold works on something that it waits for. */
export const setupPollMs = 1_000;

/**
 * The first run's view: read once, again after `refresh`, and each second
 * while Verifold looks for the harnesses, an agent writes, the prices load,
 * the skill catalogs load, or Verifold lists the person's own skills. Each
 * read has a number: `refresh` returns the number of the read that it
 * starts, and `landed` is the number of the last read that answered, with
 * its view or its error. A new read stops the one before it.
 */
export function useSetup(read: SetupActions['read']): {
  readonly view: SetupView | null;
  readonly error: string | null;
  readonly refresh: () => number;
  readonly landed: number;
} {
  const [view, setView] = useState<SetupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const [reads, setReads] = useState(0);
  const [landed, setLanded] = useState(-1);
  const refresh = useCallback(() => {
    asked.current += 1;
    setReads(asked.current);
    return asked.current;
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      if ('value' in loaded) {
        setView(loaded.value);
        setError(null);
      } else setError(loaded.error);
      setLanded(reads);
    });
    return () => controller.abort();
  }, [read, reads]);
  const waiting =
    view !== null &&
    (view.agents.checking ||
      view.about.busy !== null ||
      view.money.reading ||
      Boolean(view.skills?.busy) ||
      Boolean(view.skills?.ownReading));
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(refresh, setupPollMs);
    return () => clearTimeout(timer);
  }, [waiting, reads, refresh]);
  return { view, error, refresh, landed };
}
