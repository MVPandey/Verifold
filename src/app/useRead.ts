import { useCallback, useEffect, useState } from 'react';
import type { Loaded } from './api.ts';

/**
 * A read of a page's records: when the page opens, when `tick` changes, and on
 * `reread`. A read that fails keeps what the page has, and says so. A new
 * `read` starts empty, so the page shows no answer of another read. Null: no
 * read now.
 */
export function useRead<T>(
  read: ((signal: AbortSignal) => Promise<Loaded<T>>) | null,
  tick: string | number,
): {
  readonly value: T | null;
  readonly failed: string | null;
  readonly reread: () => void;
} {
  const [loaded, setLoaded] = useState<{
    readonly read: unknown;
    readonly value: T;
  } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!read) return;
    const stop = new AbortController();
    void read(stop.signal).then((result) => {
      if (stop.signal.aborted) return;
      if ('error' in result) setFailed(result.error);
      else {
        setLoaded({ read, value: result.value });
        setFailed(null);
      }
    });
    return () => stop.abort();
  }, [read, tick, reads]);
  return {
    value: loaded?.read === read ? (loaded?.value ?? null) : null,
    failed,
    reread: useCallback(() => setReads((count) => count + 1), []),
  };
}
