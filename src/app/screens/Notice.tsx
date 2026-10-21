import type { ReactNode } from 'react';
import type { Route } from '../route.ts';
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

const later: Record<Exclude<Route['page'], 'lab'>, string> = {
  direction: 'A direction',
  call: 'A call',
  run: 'A run',
  proof: 'Proof',
  answer: 'The answer',
  search: 'Search',
  projects: 'Your projects',
  unknown: 'This page',
};

/** Pages that later steps of the new app build. Until then the desk has them. */
export function ComingSoon({ route }: { readonly route: Route }): ReactNode {
  if (route.page === 'lab') return null;
  return (
    <Notice title={`${later[route.page]} comes in a later step`}>
      <p>
        The new app is a preview. Until this page is ready, the desk has it:{' '}
        <a href="/">open the desk</a>.
      </p>
      <p>
        <a href={href.lab}>Back to the lab</a>
      </p>
    </Notice>
  );
}
