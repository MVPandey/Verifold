import type { ReactNode } from 'react';
import type { Call } from '../../protocol/api.ts';
import { decideId } from '../call.ts';
import { asked, since, usd } from '../format.ts';
import { href } from '../route.ts';

/**
 * The oldest call that waits for the person: the question, the price of the
 * agents' pick, who asked, and how long they have waited.
 */
export function NeedsYouLine({
  call,
  more,
  now,
}: {
  readonly call: Call;
  /** Other open calls after this one. */
  readonly more: number;
  readonly now: number;
}): ReactNode {
  const pick = call.pick === null ? undefined : call.options[call.pick];
  return (
    <div className="needs">
      <span className="needs__label">Needs you</span>
      <span className="needs__body">
        <b>
          {call.question}
          {pick?.usd !== null && pick?.usd !== undefined && ` ${usd(pick.usd)}`}
        </b>
        <span className="needs__meta">
          {asked(call.askers)} · waiting {since(call.at, now)}
          {more > 0 &&
            ` · ${more} more ${more === 1 ? 'call' : 'calls'} after this`}
        </span>
      </span>
      <a
        id={decideId}
        className="button button--dark"
        href={href.call(call.id)}
      >
        Decide
      </a>
    </div>
  );
}
