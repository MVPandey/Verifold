import type { ReactNode } from 'react';
import type { Call } from '../../protocol/api.ts';
import { decideId, fromLab } from '../call.ts';
import { asked, since, usd } from '../format.ts';
import { href } from '../route.ts';

/**
 * The oldest call that waits for the person: the question, the price of the
 * agents' pick, who asked, and how long they have waited. `failure`: why the
 * person's last answer to it failed after Verifold accepted it.
 */
export function NeedsYouLine({
  call,
  more,
  now,
  failure = null,
}: {
  readonly call: Call;
  /** Other open calls after this one. */
  readonly more: number;
  readonly now: number;
  readonly failure?: string | null;
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
        {failure && (
          <span role="alert" className="needs__failure">
            {failure}
          </span>
        )}
      </span>
      <a
        id={decideId}
        className="button button--dark"
        href={href.call(call.id)}
        onClick={(event) => {
          // A plain click opens the call over the lab, marked so that its Close goes back.
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey
          )
            return;
          event.preventDefault();
          history.pushState(fromLab, '', href.call(call.id));
          dispatchEvent(new HashChangeEvent('hashchange'));
        }}
      >
        Decide
      </a>
    </div>
  );
}
