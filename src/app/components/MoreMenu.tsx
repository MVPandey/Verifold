import { useEffect, useRef, type ReactNode } from 'react';
import { Dots } from './Icons.tsx';

/**
 * The "More actions" menu beside a page's title, as on the direction
 * artboard: a button with three dots that opens a short list of links and
 * buttons. Each item is a link or a button with the class `more-menu__item`.
 * A new address closes it, such as a call that opens over the page.
 */
export function MoreMenu({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (): void => {
      if (ref.current) ref.current.open = false;
    };
    addEventListener('hashchange', close);
    return () => removeEventListener('hashchange', close);
  }, []);
  return (
    <details ref={ref} className="more-menu">
      <summary className="more-menu__button" aria-label="More actions">
        <Dots />
      </summary>
      <div className="more-menu__list">{children}</div>
    </details>
  );
}
