import { useState, type ReactNode } from 'react';
import type { Away, Brief, BriefLine, Lab } from '../../protocol/api.ts';
import {
  briefFoot,
  briefHead,
  lineHref,
  lineText,
  lineWords,
  shortTime,
} from '../brief-view.ts';
import { withoutIds } from '../ids.ts';
import { href } from '../route.ts';
import { useAction } from '../useAction.ts';
import { useView } from '../view-mode.ts';
import type { ActOutcome } from '../api.ts';
import { IdText } from './IdText.tsx';
import { PlainToggle } from './PlainToggle.tsx';

/** One line: its kind and time, its words, how strong the record is, and its thread. */
function BriefRow({
  line,
  now,
}: {
  readonly line: BriefLine;
  readonly now: number;
}): ReactNode {
  const { mode } = useView();
  const [original, setOriginal] = useState(false);
  return (
    <div className="brief__line">
      <span className={`brief-tag brief-tag--${line.kind}`}>
        {lineWords[line.kind]}
        <small>{shortTime(line.at, now)}</small>
      </span>
      <div className="brief__text">
        <IdText text={lineText(line, mode, original)} />
      </div>
      <div className="brief__links">
        <span className="cue">{line.evidence}</span>
        {mode === 'simple' && line.plain !== null && (
          <PlainToggle
            original={original}
            onToggle={() => setOriginal(!original)}
          />
        )}
        <a href={lineHref(line)}>Thread</a>
      </div>
    </div>
  );
}

/** The time away in numbers from the records, with its way to end. */
function AwayNumbers({
  away,
  onDismiss,
}: {
  readonly away: Away;
  readonly onDismiss: ((key: string) => Promise<ActOutcome>) | null;
}): ReactNode {
  const { mode } = useView();
  const dismiss = useAction<null>((_value, key) =>
    onDismiss ? onDismiss(key) : Promise.resolve({ ok: true }),
  );
  const { news } = away;
  const counts = news?.counts ? `${news.counts}.` : '';
  const words = [
    mode === 'simple' ? withoutIds(counts) : counts,
    news?.cost ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="brief__foot brief__away">
      <span>{words || 'Nothing changed.'}</span>
      {onDismiss && (
        <button
          type="button"
          className="see"
          disabled={dismiss.busy}
          onClick={() => void dismiss.submit(null)}
        >
          Dismiss
        </button>
      )}
      {dismiss.error && (
        <span role="alert" className="composer__error">
          {dismiss.error}
        </span>
      )}
    </div>
  );
}

/**
 * The brief: "Since you left". Its top line comes from the records. Each line
 * shows its plain words only once they passed their check, and otherwise it
 * quotes its posts. Before the first brief, a short line says so, and nothing
 * stands in for a summary.
 */
export function BriefCard({
  lab,
  brief,
  now,
  onDismiss,
}: {
  readonly lab: Lab;
  readonly brief: Brief;
  readonly now: number;
  readonly onDismiss: ((key: string) => Promise<ActOutcome>) | null;
}): ReactNode {
  const { mode } = useView();
  const decisions =
    lab.threads?.filter((thread) => thread.state === 'decided').length ?? 0;
  const foot = briefFoot(brief.lines, mode);
  return (
    <section aria-labelledby="brief">
      <div className="section-head">
        <h2 id="brief" className="section-title">
          {briefHead({ away: lab.away, brief }, now)}
        </h2>
        <a className="section-link" href={href.threads}>
          Decisions ({decisions})
        </a>
      </div>
      <div className="card">
        <p className="brief__top">
          {mode === 'technical' && brief.topIds ? (
            <IdText text={brief.topIds} />
          ) : (
            brief.top
          )}
        </p>
        {brief.lines.map((line, index) => (
          // A new view starts with each line closed.
          <BriefRow key={`${mode}-${line.at}-${index}`} line={line} now={now} />
        ))}
        {!brief.at && (
          <p className="brief__none">
            The Coordinator has no lines yet. Its first lines come after the
            next change in the lab.
          </p>
        )}
        {foot && <p className="brief__foot">{foot}</p>}
        {lab.away && <AwayNumbers away={lab.away} onDismiss={onDismiss} />}
      </div>
    </section>
  );
}
