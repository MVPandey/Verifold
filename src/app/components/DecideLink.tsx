import type { ReactNode } from 'react';
import { openCall } from '../call.ts';
import { href } from '../route.ts';

/**
 * Decide: a link that opens a call over this page. A plain click keeps the
 * page under the call, and the call's Close comes back to it. A click with
 * a key held, or with another button, follows the link as usual.
 */
export function DecideLink({
  call,
  id,
  className,
}: {
  readonly call: string;
  readonly id?: string;
  readonly className?: string;
}): ReactNode {
  return (
    <a
      id={id}
      className={className}
      href={href.call(call)}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey
        )
          return;
        event.preventDefault();
        openCall(call);
      }}
    >
      Decide
    </a>
  );
}
