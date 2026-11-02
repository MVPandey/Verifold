import { useState, type ReactNode } from 'react';
import type { Away, Brief, BriefLine, Lab } from '../../protocol/api.ts';
import {
  briefFoot,
  briefHead,
  decisionCount,
  hasOriginal,
  lineHref,
  lineWords,
  topLine,
} from '../brief-view.ts';
import { shortTime } from '../format.ts';
import { href } from '../route.ts';
import { useAction } from '../useAction.ts';
import { useView } from '../view-mode.ts';
import type { ActOutcome } from '../api.ts';
import { AwayNews } from './AwayDigest.tsx';
import { IdText } from './IdText.tsx';
import { LineWords } from './LineWords.tsx';
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
        <LineWords line={line} original={original} />
      </div>
      <div className="brief__links">
        <span className="cue">{line.evidence}</span>
        {hasOriginal(line, mode) && (
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

/** What came in the time away, from the records, with its way to end. */
function AwayBlock({
  away,
  onDismiss,
}: {
  readonly away: Away;
  readonly onDismiss: ((key: string) => Promise<ActOutcome>) | null;
}): ReactNode {
  const dismiss = useAction<null>((_value, key) =>
    onDismiss ? onDismiss(key) : Promise.resolve({ ok: true }),
  );
  return (
    <div className="brief__foot brief__away">
      <div className="brief__news">
        {away.news && <AwayNews news={away.news} />}
      </div>
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
  const foot = briefFoot(brief.lines, mode);
  const decisions = decisionCount(lab.threads);
  return (
    <section aria-labelledby="brief">
      <div className="section-head">
        <h2 id="brief" className="section-title">
          {briefHead({ away: lab.away, brief }, now)}
        </h2>
        {decisions > 0 && (
          <a className="section-link" href={href.threads}>
            Decisions ({decisions})
          </a>
        )}
      </div>
      <div className="card">
        <p className="brief__top">
          <IdText text={topLine(brief, mode)} />
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
        {lab.away && <AwayBlock away={lab.away} onDismiss={onDismiss} />}
      </div>
    </section>
  );
}
