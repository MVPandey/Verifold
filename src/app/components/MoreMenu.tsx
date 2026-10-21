import type { ReactNode } from 'react';
import { Dots } from './Icons.tsx';

/**
 * The "More actions" menu beside a page's title, as on the direction
 * artboard: a button with three dots that opens a short list of links and
 * buttons. Each item is a link or a button with the class `more-menu__item`.
 */
export function MoreMenu({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <details className="more-menu">
      <summary className="more-menu__button" aria-label="More actions">
        <Dots />
      </summary>
      <div className="more-menu__list">{children}</div>
    </details>
  );
}
