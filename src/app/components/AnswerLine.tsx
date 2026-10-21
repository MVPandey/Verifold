import type { ReactNode } from 'react';
import type { Call, Lab } from '../../protocol/api.ts';
import type { ActOutcome } from '../api.ts';
import { applyingText, failureOf, optionLines, undoLeft } from '../call.ts';
import { span } from '../format.ts';
import { useAction } from '../useAction.ts';

/**
 * An answer that is not settled yet. While Verifold applies it: what starts,
 * never a final "You chose". While it can be undone: the choice, Undo, the
 * time left, and what the undo does. When an undo failed after Verifold
 * accepted it: why. Nothing otherwise. `question`: name the call, as on the
 * lab home, where several answers can wait at once.
 */
export function AnswerLine({
  call,
  lab,
  now,
  question = false,
  onUndo,
}: {
  readonly call: Call;
  readonly lab: Lab;
  readonly now: number;
  readonly question?: boolean;
  readonly onUndo: (call: string, key: string) => Promise<ActOutcome>;
}): ReactNode {
  const undo = useAction<string>(onUndo);
  const option = call.answer ? call.options[call.answer.option] : undefined;
  if (!option || call.state !== 'answered') return null;
  const named = question ? <> on “{call.question}”</> : null;
  if (call.applying)
    return (
      <div className="answer answer--busy" role="status">
        {applyingText(option)}
        {named}
      </div>
    );
  const failure = failureOf(lab, call);
  const left = undoLeft(call, now);
  if (left === null)
    return failure ? (
      <div className="answer answer--failed" role="alert">
        {failure.text}
      </div>
    ) : null;
  const lines = optionLines(option, call, lab);
  const problem = undo.error ?? failure?.text ?? null;
  return (
    <div className="answer" role="status">
      <span>
        You chose “{option.label}”{named}.{' '}
        <button
          type="button"
          className="answer__undo"
          disabled={undo.busy}
          onClick={() => void undo.submit(call.id)}
        >
          Undo
        </button>{' '}
        <span className="answer__fine">
          {span(left)} left. {lines ? `${lines.undo} ` : ''}Then the call asks
          again.
        </span>
      </span>
      {problem && (
        <span role="alert" className="answer__error">
          {problem}
        </span>
      )}
    </div>
  );
}
