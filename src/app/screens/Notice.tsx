import type { ReactNode } from 'react';
import { href } from '../route.ts';

/** A short page with a title, a line, and a way on. */
export function Notice({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <main className="notice">
      <h1>{title}</h1>
      {children}
    </main>
  );
}

export function NotFound(): ReactNode {
  return (
    <Notice title="This page does not exist">
      <p>
        <a href={href.lab}>Back to the lab</a>
      </p>
    </Notice>
  );
}
