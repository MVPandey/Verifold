import type { ReactNode } from 'react';
import { clock } from '../format.ts';
import type { Connection } from '../store.ts';
import { StatusBar } from './StatusBar.tsx';

/** A line when the stream dropped: the page shows the lab as of `at`. Nothing while the stream is live. */
export function ConnectionBar({
  connection,
  at,
}: {
  readonly connection: Connection;
  readonly at: string;
}): ReactNode {
  if (connection === 'reconnecting')
    return (
      <StatusBar tone="muted">
        Reconnecting to Verifold. This shows the lab as of {clock(at)}.
      </StatusBar>
    );
  if (connection === 'unreachable')
    return (
      <StatusBar tone="muted">
        Can't reach Verifold. Is it running? This shows the lab as of{' '}
        {clock(at)}. Reload the page to try again.
      </StatusBar>
    );
  return null;
}
