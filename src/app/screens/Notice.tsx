import { useId, useState, type ReactNode } from 'react';
import type { Snapshot } from '../../protocol/api.ts';
import type { ActOutcome } from '../api.ts';
import { href } from '../route.ts';
import { useAction } from '../useAction.ts';

/** A lab's start: its question and its time budget in hours. */
export interface LabStart {
  readonly question: string;
  readonly hours: number;
}

/** The lab's default time budget and the most hours of one, as the lab checks them. */
export const labHours = { default: 8, max: 168 } as const;

/** Whole hours from 1 to the most, or null. */
export function validHours(text: string): number | null {
  const hours = Number(text);
  return /^\d{1,3}$/.test(text.trim()) && hours >= 1 && hours <= labHours.max
    ? hours
    : null;
}

/** A short page with a title, a line, and a way on. */
export function Notice({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <main className="notice">
      <h1>{title}</h1>
      {children}
    </main>
  );
}

export function NotFound(): ReactNode {
  return (
    <Notice title="This page does not exist">
      <p>
        <a href={href.lab}>Back to the lab</a>
      </p>
    </Notice>
  );
}

/**
 * A project without a lab: why its lab's last start failed, and a box with
 * its question, which the person can change, and the time budget, to start
 * the lab.
 */
export function NoLab({
  snapshot,
  onStart,
}: {
  readonly snapshot: Snapshot;
  readonly onStart: (start: LabStart, key: string) => Promise<ActOutcome>;
}): ReactNode {
  const id = useId();
  const [question, setQuestion] = useState(snapshot.question ?? '');
  const [hours, setHours] = useState(String(labHours.default));
  const action = useAction<LabStart>(
    onStart,
    (a, b) => a.question === b.question && a.hours === b.hours,
  );
  const budget = validHours(hours);
  return (
    <Notice title={`${snapshot.project} has no lab yet`}>
      {snapshot.startProblem && (
        <p role="alert">The lab did not start: {snapshot.startProblem}</p>
      )}
      <form
        className="lab-start"
        onSubmit={(event) => {
          event.preventDefault();
          const asked = question.trim();
          if (!asked || budget === null || action.busy) return;
          void action.submit({ question: asked, hours: budget });
        }}
      >
        <label className="field" htmlFor={`${id}-question`}>
          Your question
        </label>
        <textarea
          id={`${id}-question`}
          className="field__input"
          rows={3}
          maxLength={4000}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <label className="field" htmlFor={`${id}-hours`}>
          Time budget, in hours
        </label>
        <input
          id={`${id}-hours`}
          className="field__input field__input--short"
          inputMode="numeric"
          value={hours}
          onChange={(event) => setHours(event.target.value)}
        />
        {budget === null && (
          <p role="alert" className="composer__error">
            Give whole hours from 1 to {labHours.max}.
          </p>
        )}
        <p>
          <button
            type="submit"
            className="button button--primary"
            disabled={action.busy || !question.trim() || budget === null}
          >
            Start the lab
          </button>
        </p>
        {action.error && <p role="alert">{action.error}</p>}
      </form>
      <p>
        The first agent reads your question and posts a plan. Work that costs
        nothing starts at once. You change the plan by replying to it. When the
        time budget ends, the lab pauses.
      </p>
      <p>
        You can <a href={href.setup('agents')}>change your profile</a> here.
      </p>
    </Notice>
  );
}
