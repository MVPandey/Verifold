import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type {
  BringRead,
  FileDiff,
  Lab,
  Run,
  Snapshot,
} from '../../protocol/api.ts';
import type { ActOutcome, Loaded } from '../api.ts';
import {
  answerStatus,
  broughtLine,
  findings,
  runsLine,
  signedOff,
  stillOpen,
  stoppedWithout,
  tagNames,
  yourCalls,
  type Finding,
} from '../answer.ts';
import { clock } from '../format.ts';
import { afterSend } from '../intent.ts';
import { href } from '../route.ts';
import type { Connection } from '../store.ts';
import { useAction } from '../useAction.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { DecideLink } from '../components/DecideLink.tsx';
import { Chevron } from '../components/Icons.tsx';
import { RunChip } from '../components/RunChip.tsx';
import { Verdict } from '../components/Verdict.tsx';
import type { LabActions } from './LabHome.tsx';

/** What the answer and bring-in pages ask of Verifold: the desk's own actions and reads for them. */
export interface AnswerActions {
  /** Sign off the answer, with its line or none. */
  readonly signOff: (note: string, key: string) => Promise<ActOutcome>;
  /** Take a direction's newest work, so a bring-in shows exactly the files that come in. */
  readonly look: (direction: string, key: string) => Promise<ActOutcome>;
  /** Copy ticked files of a direction, at the commit that the person looked at, into the project folder. */
  readonly bring: (
    direction: string,
    commit: string,
    files: readonly string[],
    key: string,
  ) => Promise<ActOutcome>;
  /** Undo a bring-in of a direction, named by when it came in and its commit. */
  readonly undo: (
    direction: string,
    at: string,
    commit: string,
    key: string,
  ) => Promise<ActOutcome>;
  /** What a bring-in of a direction can copy, and its bring-ins so far. */
  readonly read: (
    direction: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<BringRead>>;
  /** One file's diff at the commit of a bring-in. */
  readonly diff: (
    direction: string,
    file: string,
    commit: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<FileDiff>>;
}

/** A line as a sentence: it ends with a stop. */
function sentence(text: string): string {
  const bare = text.trim();
  return /[.!?…]$/.test(bare) ? bare : `${bare}.`;
}

/** A web address as a short link text: "arxiv.org/abs/2603.05488". */
export function shortSource(url: string): string {
  return url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '');
}

function TagChip({ tag }: { readonly tag: Finding['tag'] }): ReactNode {
  if (!tag) return null;
  return (
    <span className={`finding__tag finding__tag--${tag}`}>{tagNames[tag]}</span>
  );
}

/** One finding: its tag, then the direction and its evidence, or a source of the plan, with its links. */
function FindingRow({
  finding,
  lab,
  runs,
}: {
  readonly finding: Finding;
  readonly lab: Lab;
  readonly runs: ReadonlyMap<string, Run>;
}): ReactNode {
  const { direction, source } = finding;
  const brought = direction ? broughtLine(direction) : null;
  return (
    <li className="finding">
      <TagChip tag={finding.tag} />
      <div className="finding__body">
        {direction ? (
          <>
            <span className="finding__title">
              <Verdict direction={direction} />
              <a href={href.direction(direction.id)}>{direction.title}</a>
            </span>
            {(finding.text || finding.check) && (
              <p className="finding__text">
                {[finding.text, finding.check]
                  .filter((part) => part)
                  .map((part) => sentence(part ?? ''))
                  .join(' ')}
              </p>
            )}
            {finding.untagged && (
              <span className="finding__meta">{finding.untagged}</span>
            )}
            {(finding.runs.length > 0 ||
              finding.post ||
              brought ||
              lab.agentsHere) && (
              <span className="finding__links">
                {finding.runs.map((id) => (
                  <RunChip key={id} id={id} runs={runs} />
                ))}
                {finding.post && (
                  <a className="proof" href={href.lab}>
                    On the board
                  </a>
                )}
                {brought && <span className="finding__meta">{brought}</span>}
                {lab.agentsHere && (
                  <a className="finding__bring" href={href.bring(direction.id)}>
                    Bring in files
                  </a>
                )}
              </span>
            )}
          </>
        ) : (
          <p className="finding__text">
            {sentence(finding.text)}
            {source && (
              <>
                {' '}
                <span className="finding__meta">
                  {source.url ? (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {shortSource(source.url)}
                    </a>
                  ) : (
                    source.text
                  )}
                  {source.date && ` · ${source.date}`}
                </span>
              </>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

/** Directions that are not settled, and the calls that wait for the person. */
function StillOpen({ lab }: { readonly lab: Lab }): ReactNode {
  const open = stillOpen(lab);
  const agents = new Map(lab.agents.map((agent) => [agent.id, agent]));
  if (!open.length && !lab.needsYou.length) return null;
  return (
    <section className="section" aria-labelledby="still-open">
      <h2 id="still-open" className="section__title">
        Still open
      </h2>
      <ul className="still-open">
        {open.map((direction) => {
          const agent = agents.get(direction.agent);
          return (
            <li key={direction.id}>
              <a href={href.direction(direction.id)}>{direction.title}</a>
              {direction.disputed
                ? ' is disputed. A rerun by the other harness settles it.'
                : agent
                  ? ` · ${agent.handle}: ${agent.live.text}`
                  : ''}
            </li>
          );
        })}
        {lab.needsYou.map((call) => (
          <li key={call.id}>
            {call.question} <DecideLink call={call.id} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The person's sign-off: one optional line, and what it keeps. */
function SignOff({
  lab,
  onSignOff,
}: {
  readonly lab: Lab;
  readonly onSignOff: (note: string, key: string) => Promise<ActOutcome>;
}): ReactNode {
  const id = useId();
  const [note, setNote] = useState('');
  const action = useAction(onSignOff);
  // Only a submit signs off: the button, or Enter. Browsers do not submit on the Enter that ends a word in an input method.
  const sign = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const sent = note;
    if (action.busy) return;
    if (await action.submit(sent.trim()))
      setNote((current) => afterSend(current, sent));
  };
  return (
    <section className="section signoff" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="section__title">
        Sign off
      </h2>
      <p className="signoff__text">
        {lab.signoff
          ? `You signed off at ${clock(lab.signoff.at)}. A new sign-off replaces it.`
          : "Sign off when you agree with the answer. Verifold keeps each direction's verdict, its newest commit, and the check behind it."}{' '}
        A sign-off stops no agent: pause the lab, or stop its directions, for
        that.
      </p>
      <form className="signoff__form" onSubmit={(event) => void sign(event)}>
        <label htmlFor={id} className="signoff__label">
          The answer in one line (optional)
        </label>
        <div className="signoff__row">
          <input
            id={id}
            className="signoff__input"
            type="text"
            value={note}
            {...(lab.signoffLimit === undefined
              ? {}
              : { maxLength: lab.signoffLimit })}
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            type="submit"
            className="button button--primary"
            disabled={action.busy}
          >
            Sign off
          </button>
        </div>
        {action.error && (
          <span role="alert" className="composer__error">
            {action.error}
          </span>
        )}
      </form>
    </section>
  );
}

/**
 * The lab's answer, as on the v9 canvas ("13. The answer"): where it stands,
 * what the lab found, each finding tagged by where it comes from, what is
 * still open, the person's calls, and the sign-off. Every word comes from
 * the lab's records: before a sign-off, the page's title is the question.
 */
export function AnswerPage({
  snapshot,
  lab,
  connection,
  now,
  actions,
  answerActions,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
  readonly answerActions: AnswerActions;
}): ReactNode {
  const found = findings(lab);
  const calls = yourCalls(lab);
  const stopped = stoppedWithout(lab);
  const runs = new Map(lab.runs.map((run) => [run.id, run]));
  const line = lab.signoff?.note ?? null;
  return (
    <div className="page">
      <AppHeader
        project={snapshot.project}
        lab={lab}
        now={now}
        onPause={actions.pause}
      />
      <main className="main">
        <div className="column column--detail">
          <ConnectionBar connection={connection} at={snapshot.at} />
          <a className="back" href={href.lab}>
            <Chevron to="left" />
            The lab
          </a>
          <div className="answer-head">
            <span className="answer-head__status">{answerStatus(lab)}</span>
            <h1 className="answer-head__title">{line ?? lab.question}</h1>
            {line && (
              <p className="answer-head__question">
                The question: {lab.question}
              </p>
            )}
          </div>
          <section className="section" aria-labelledby="found">
            <div className="section__head">
              <h2 id="found" className="section__title">
                What we found
              </h2>
              <span className="answer-legend">
                Data: from runs here. Literature: from sources the plan checked.
                Our reasoning: not backed by a run.
              </span>
            </div>
            {found.length > 0 ? (
              <ol className="findings">
                {found.map((finding) => (
                  <FindingRow
                    key={finding.key}
                    finding={finding}
                    lab={lab}
                    runs={runs}
                  />
                ))}
              </ol>
            ) : (
              <p className="answer-empty">
                Nothing is settled yet. A direction shows here once it holds up,
                leads, or is ruled out.
              </p>
            )}
            {(lab.omitted.directions !== undefined ||
              lab.omitted.plan !== undefined ||
              lab.omitted.facts !== undefined) && (
              <span className="more">
                This view of a large lab leaves out some directions or facts.
              </span>
            )}
          </section>
          <StillOpen lab={lab} />
          {stopped.length > 0 && (
            <p className="answer-line">
              <b>Stopped without a verdict:</b>{' '}
              {stopped.map((direction, index) => (
                <span key={direction.id}>
                  {index > 0 && ', '}
                  <a href={href.direction(direction.id)}>{direction.title}</a>
                </span>
              ))}
              .
            </p>
          )}
          <p className="answer-line">{runsLine(lab)}</p>
          <p className="answer-line">
            <b>Your calls:</b>{' '}
            {calls.length
              ? `${calls.join(' · ')}. The agents made the rest, all on the board.`
              : 'none. The agents made every choice, all on the board.'}
          </p>
          {lab.agentsHere && !lab.signoff && signedOff(lab) ? (
            <p className="answer-line muted">
              You signed off. This view of a large lab leaves out the details.
            </p>
          ) : lab.agentsHere ? (
            <SignOff lab={lab} onSignOff={answerActions.signOff} />
          ) : (
            <p className="answer-line muted">
              This view only shows the lab. Run verifold in the project folder
              to sign off or bring files in.
            </p>
          )}
          {lab.agentsHere && (
            <p className="answer-line muted">
              Done with this question? <a href={href.startOver}>Start over</a>{' '}
              moves this run into History and keeps the question.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
