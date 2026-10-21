import { useCallback, useEffect, useState } from 'react';
import type { SetupView } from '../protocol/api.ts';
import type { SetupActions } from './setup.ts';

/** How often the page reads the first run again while Verifold works on something that it waits for. */
export const setupPollMs = 1_000;

/**
 * The first run's view: read once, again after `refresh`, and each second
 * while Verifold looks for the harnesses, an agent writes, or the prices
 * load.
 */
export function useSetup(read: SetupActions['read']): {
  readonly view: SetupView | null;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const [view, setView] = useState<SetupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads((count) => count + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      if ('value' in loaded) {
        setView(loaded.value);
        setError(null);
      } else setError(loaded.error);
    });
    return () => controller.abort();
  }, [read, reads]);
  const waiting =
    view !== null &&
    (view.agents.checking || view.about.busy !== null || view.money.reading);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(refresh, setupPollMs);
    return () => clearTimeout(timer);
  }, [waiting, reads, refresh]);
  return { view, error, refresh };
}
