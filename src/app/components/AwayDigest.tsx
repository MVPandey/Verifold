import type { ReactNode } from 'react';
import type { Away, AwayLine } from '../../protocol/api.ts';
import type { ActOutcome } from '../api.ts';
import { clock, since } from '../format.ts';
import { href } from '../route.ts';
import { useAction } from '../useAction.ts';
import { Check, Cross, Plus, Ring, Up, Warning } from './Icons.tsx';

/** The mark of a line is its row's. The words beside it say the same, so the mark is decoration. */
const marks: Record<AwayLine['mark'], () => ReactNode> = {
  'holds-up': () => <Check />,
  'ruled-out': () => <Cross />,
  leading: () => <Up />,
  open: () => <Ring />,
  disputed: () => <Warning />,
  new: () => <Plus />,
};

/**
 * "While you were away": what changed since the person left the lab, until
 * they dismiss it. The lines and counts come from the server, in the words
 * of the desk's Home ("12. Back after a night" on the v9 canvas). A server
 * from before these words sends only the time away. `onDismiss`: null when
 * the page cannot dismiss it, as in a test.
 */
export function AwayDigest({
  away,
  now,
  onDismiss,
}: {
  readonly away: Away;
  readonly now: number;
  readonly onDismiss: ((key: string) => Promise<ActOutcome>) | null;
}): ReactNode {
  const dismiss = useAction<null>((_value, key) =>
    onDismiss ? onDismiss(key) : Promise.resolve({ ok: true }),
  );
  const { news } = away;
  const quiet = news !== undefined && !news.lines.length && !news.counts;
  return (
    <section className="away" aria-labelledby="away-title">
      <div className="away__head">
        <h2 id="away-title" className="away__title">
          While you were away
        </h2>
        {onDismiss && (
          <button
            type="button"
            className="button"
            disabled={dismiss.busy}
            onClick={() => void dismiss.submit(null)}
          >
            Dismiss
          </button>
        )}
      </div>
      <p className="away__since">
        Since {clock(away.since)}, {since(away.since, now)} ago.
      </p>
      {quiet && (
        <p className="away__quiet">
          {news.cost ? 'No post, run, or call came.' : 'Nothing changed.'}
        </p>
      )}
      {news && news.lines.length > 0 && (
        <ul className="away__lines">
          {news.lines.map((line) => (
            <li
              key={line.direction}
              className={`away__line away__line--${line.mark}`}
            >
              <span className="away__mark">{marks[line.mark]()}</span>
              <span className="away__text">
                <a
                  className="away__direction"
                  href={href.direction(line.direction)}
                >
                  {line.title}
                </a>
                <span className="away__said">{line.said}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {news && news.moreLines > 0 && (
        <p className="away__fine">
          {news.moreLines} more{' '}
          {news.moreLines === 1 ? 'direction' : 'directions'} changed too. Their
          rows are below.
        </p>
      )}
      {news?.counts && <p className="away__fine">{news.counts}.</p>}
      {news?.cost && <p className="away__fine">{news.cost}</p>}
      {dismiss.error && (
        <span role="alert" className="composer__error">
          {dismiss.error}
        </span>
      )}
    </section>
  );
}
