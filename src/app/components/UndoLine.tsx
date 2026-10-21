import type { ReactNode } from 'react';
import type { Call, Lab } from '../../protocol/api.ts';
import type { ActOutcome } from '../api.ts';
import { effectLines, undoLeft } from '../call.ts';
import { useAction } from '../useAction.ts';

/**
 * An answer that the person can still undo: the option they chose, an Undo
 * button, the minutes left, and what the undo does. Nothing once the window
 * closes. `question`: name the call, as on the lab home, where several
 * answers can wait for an undo at once.
 */
export function UndoLine({
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
  const left = undoLeft(call, now);
  if (!option || left === null) return null;
  const lines = option.effect ? effectLines(option.effect, call, lab) : null;
  return (
    <div className="undo" role="status">
      <span>
        You chose “{option.label}”{question && <> on “{call.question}”</>}.{' '}
        <button
          type="button"
          className="undo__button"
          disabled={undo.busy}
          onClick={() => void undo.submit(call.id)}
        >
          Undo
        </button>{' '}
        <span className="undo__fine">
          {left} min left. {lines ? `${lines.undo} ` : ''}Then the call asks
          again.
        </span>
      </span>
      {undo.error && (
        <span role="alert" className="undo__error">
          {undo.error}
        </span>
      )}
    </div>
  );
}
