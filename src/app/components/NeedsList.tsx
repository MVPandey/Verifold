import type { ReactNode } from 'react';
import type { Lab } from '../../protocol/api.ts';
import { decideId } from '../call.ts';
import { needRows } from '../needs.ts';
import { DecideLink } from './DecideLink.tsx';
import { IdText } from './IdText.tsx';

/** Needs you: each call and each ask to the person, with who asks, the wait, the cost, and the latest useful answer. */
export function NeedsList({
  lab,
  now,
}: {
  readonly lab: Lab;
  readonly now: number;
}): ReactNode {
  const rows = needRows(lab, now);
  if (!rows.length) return null;
  const left = lab.omitted.needsYou ?? 0;
  return (
    <section className="needs-box" aria-labelledby="needs-you">
      <h2 id="needs-you" className="needs-box__label">
        Needs you
      </h2>
      {rows.map((row, index) => (
        <div key={row.key} className="need">
          <div className="need__text">
            <b>
              <IdText text={row.text} />
            </b>
            <span className="need__sub">{row.sub}</span>
            {row.failure && (
              <span role="alert" className="needs__failure">
                {row.failure}
              </span>
            )}
          </div>
          {row.call ? (
            <DecideLink
              call={row.call}
              id={index === 0 ? decideId : undefined}
              className="btn"
            />
          ) : (
            <a className="btn" href={row.reply ?? undefined}>
              Reply
            </a>
          )}
        </div>
      ))}
      {left > 0 && <p className="need need__sub">{left} more not shown.</p>}
    </section>
  );
}
