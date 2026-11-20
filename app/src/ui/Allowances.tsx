import { useState } from 'react';
import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import { messageOf } from '../api/client.ts';
import type { AllowanceView, LabView, PostView } from '../api/types.ts';
import {
  NOTHING_DONE,
  actionAmount,
  actionMark,
  allowanceHeading,
  allowanceKicker,
  allowanceOf,
  draftFacts,
  holderName,
  isAction,
  meterPercent,
  missedHeading,
  missedRow,
  recordedNote,
  requestWords,
  shownAllowances,
  stoppedLine,
  usedLine,
} from '../model/allowances.ts';
import type { ActionPost } from '../model/allowances.ts';
import { clock } from '../model/format.ts';
import { href } from '../model/route.ts';

/** Runs one press of the person, shows that it runs, and shows why the server refused it. */
export function usePress(): {
  readonly busy: boolean;
  readonly error: string | null;
  readonly run: (press: () => Promise<unknown>) => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (press: () => Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    press().then(
      () => {
        setBusy(false);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure));
      },
    );
  };
  return { busy, error, run };
}

/** Why the server refused the person's press, while it did. */
export function Refusal(props: { readonly error: string | null }): ReactElement | null {
  return props.error ? (
    <p className="error" role="alert">
      {props.error}
    </p>
  ) : null;
}

/** The note that says what the board does about an allowance, and what it does not do. */
export function RecordedNote(props: { readonly name: string }): ReactElement {
  return (
    <p className="a-note">
      <b>Recorded, not enforced.</b> {recordedNote(props.name)}
    </p>
  );
}

/**
 * One allowance. A draft shows its terms and the person's press that starts it. An allowance that the person started
 * shows what it allowed, its meter and actions, and the presses that pause every action and end it.
 */
export function AllowanceCard(props: {
  readonly api: Api;
  readonly view: AllowanceView;
  readonly lab: LabView;
  readonly now: Date;
  readonly reload: () => void;
  /** Lets the person tell the desk what to change in a draft. Without it, the draft has no such control. */
  readonly onChange?: () => void;
}): ReactElement {
  const { api, view, lab, now } = props;
  const press = usePress();
  const name = holderName(lab.agents, view.terms.holder);
  const heading = allowanceHeading(view.terms, lab.agents);
  const done = (call: () => Promise<unknown>): void => {
    press.run(() => call().then(props.reload));
  };
  if (view.state === 'draft') {
    return (
      <section className="a-card a-draft" aria-label={`Draft allowance: ${heading}`}>
        <p className="a-kicker">{allowanceKicker(view)}</p>
        <h3>{heading}</h3>
        <ul className="a-facts">
          {draftFacts(view.terms, now).map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
        <div className="a-row">
          <button
            type="button"
            className="btn primary"
            disabled={press.busy}
            onClick={() => {
              done(() => api.startAllowance(view.allowance));
            }}
          >
            Confirm allowance
          </button>
          {props.onChange ? (
            <button type="button" className="btn" onClick={props.onChange}>
              Change
            </button>
          ) : null}
        </div>
        <Refusal error={press.error} />
        <RecordedNote name={name} />
      </section>
    );
  }
  const live = view.state === 'in_force' || view.stopped;
  const paused = lab.actions_paused ?? null;
  return (
    <section
      className={`a-card${view.stopped ? ' a-stopped' : ''}`}
      aria-label={`Allowance: ${heading}`}
    >
      <p className="a-kicker">{allowanceKicker(view)}</p>
      <h3>{heading}</h3>
      <p className="a-used">{usedLine(view, now)}</p>
      <div
        className="a-meter"
        role="meter"
        aria-label="Used of the allowance"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(meterPercent(view))}
      >
        <i style={{ width: `${String(meterPercent(view))}%` }} />
      </div>
      {view.stopped ? <p className="a-stop">{stoppedLine(name)}</p> : null}
      {view.actions.length > 0 ? (
        <ul className="a-list">
          {view.actions.map((action) => {
            const mark = actionMark(action);
            return (
              <li key={action.post}>
                <time dateTime={action.at}>{clock(action.at)}</time>
                <span>
                  <a href={href({ page: 'thread', id: action.thread, post: action.post })}>
                    {action.what}
                  </a>{' '}
                  <span className={`a-mark ${mark.tone}`}>{mark.text}</span>
                </span>
                <span className="a-amt">{actionAmount(action, view.terms.unit)}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="a-none">No action yet.</p>
      )}
      {live ? (
        <>
          <div className="a-row">
            <button
              type="button"
              className={paused === null ? 'btn a-pause' : 'btn'}
              disabled={press.busy}
              onClick={() => {
                done(() => api.pauseActions(paused === null));
              }}
            >
              {paused === null ? 'Pause all actions' : 'Let actions go on'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={press.busy}
              onClick={() => {
                done(() => api.endAllowance(view.allowance));
              }}
            >
              End allowance
            </button>
          </div>
          <p className="a-undo">
            {paused === null ? '' : `You paused every action at ${clock(paused)}. `}An action
            already taken cannot be undone here.
          </p>
        </>
      ) : null}
      <Refusal error={press.error} />
      <RecordedNote name={name} />
    </section>
  );
}

/** The allowances that the lab page shows beside the wall: the drafts that wait, and each one in force or stopped. */
export function Allowances(props: {
  readonly api: Api;
  readonly lab: LabView;
  readonly now: Date;
  readonly reload: () => void;
  readonly onChange?: () => void;
}): ReactElement | null {
  const shown = shownAllowances(props.lab);
  if (shown.length === 0) return null;
  return (
    <div className="a-stack">
      {shown.map((view) => (
        <AllowanceCard
          key={view.allowance}
          api={props.api}
          view={view}
          lab={props.lab}
          now={props.now}
          reload={props.reload}
          {...(props.onChange ? { onChange: props.onChange } : {})}
        />
      ))}
    </div>
  );
}

/** One action that waits for the person: what, what it can lose, why it needs the person, and when its offer ends. */
export function ActionRequest(props: {
  readonly api: Api;
  readonly item: PostView & { readonly post: ActionPost };
  readonly lab: LabView;
  readonly now: Date;
  readonly reload: () => void;
}): ReactElement {
  const { item, lab, now } = props;
  const press = usePress();
  const words = requestWords(item, allowanceOf(lab, item.post), lab.agents, now);
  const answer = (yes: boolean): void => {
    press.run(() => props.api.decideAction(item.post.id, yes).then(props.reload));
  };
  return (
    <section className="a-card a-need" aria-label={words.heading}>
      <h3>{words.heading}</h3>
      <ul className="a-facts">
        <li>{words.wants}</li>
        <li>{words.loses}</li>
        <li className="a-ends">{words.ends}</li>
      </ul>
      <div className="a-row">
        <button
          type="button"
          className="btn primary"
          disabled={press.busy}
          onClick={() => {
            answer(true);
          }}
        >
          Allow this action
        </button>
        <button
          type="button"
          className="btn"
          disabled={press.busy}
          onClick={() => {
            answer(false);
          }}
        >
          No
        </button>
        <a href={href({ page: 'thread', id: item.post.thread, post: item.post.id })}>
          See the thread
        </a>
      </div>
      <Refusal error={press.error} />
    </section>
  );
}

/** The fold of the asks and actions that stopped waiting before the person answered. Nothing was done for them. */
export function MissedFold(props: {
  readonly lab: LabView;
  readonly now: Date;
}): ReactElement | null {
  const missed = props.lab.missed ?? [];
  if (missed.length === 0) return null;
  return (
    <details className="a-fold">
      <summary>
        <u>{missedHeading(missed)}</u> <span>{NOTHING_DONE}</span>
      </summary>
      <ul>
        {missed.map((item) => (
          <li key={item.post}>
            <a href={href({ page: 'thread', id: item.thread, post: item.post })}>
              {missedRow(item, props.lab.agents, props.now)}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The actions that wait for the person, as cards beside the wall, and the fold of what the person missed. The other
 * things that wait for the person stay rows that lead to the page of what needs them.
 */
export function ActionNeeds(props: {
  readonly api: Api;
  readonly needs: readonly PostView[];
  readonly lab: LabView;
  readonly now: Date;
  readonly reload: () => void;
}): ReactElement | null {
  const actions = props.needs.filter(isAction);
  if (actions.length === 0 && (props.lab.missed ?? []).length === 0) return null;
  return (
    <div className="a-stack">
      {actions.length > 0 ? (
        <p className="a-kicker">Actions wait for you · {actions.length}</p>
      ) : null}
      {actions.map((item) => (
        <ActionRequest
          key={item.post.id}
          api={props.api}
          item={item}
          lab={props.lab}
          now={props.now}
          reload={props.reload}
        />
      ))}
      <MissedFold lab={props.lab} now={props.now} />
    </div>
  );
}
