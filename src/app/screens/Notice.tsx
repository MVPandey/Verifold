import type { ReactNode } from 'react';
import { href, type LaterPage } from '../route.ts';

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

const later: Record<LaterPage, string> = {
  answer: 'The answer',
  'first-run': 'Setting up',
};

/** A page that a later slice of #282 builds. Until then the desk has it. */
export function ComingSoon({ page }: { readonly page: LaterPage }): ReactNode {
  return (
    <Notice title={`${later[page]} comes in a later step`}>
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

export function NotFound(): ReactNode {
  return (
    <Notice title="This page does not exist">
      <p>
        <a href={href.lab}>Back to the lab</a>
      </p>
    </Notice>
  );
}
