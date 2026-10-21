import { useId, type ReactNode } from 'react';
import type { Call } from '../../protocol/api.ts';

/** The person's answer to one question: an option, or their own words, which win when they wrote any. */
export interface Choice {
  readonly option: number;
  readonly words: string;
}

/**
 * One of the planner's questions before the plan, as on the v9 canvas ("6
 * Scoping"): the options as radio buttons with the planner's pick first
 * chosen, and a box for an answer in the person's own words.
 */
export function QuestionCard({
  number,
  call,
  choice,
  error,
  onChange,
}: {
  readonly number: number;
  readonly call: Call;
  readonly choice: Choice;
  readonly error: string | null;
  readonly onChange: (choice: Choice) => void;
}): ReactNode {
  const titleId = useId();
  const wordsId = useId();
  const own = choice.words.trim() !== '';
  return (
    <section aria-labelledby={titleId} className="question">
      <h3 id={titleId} className="question__title">
        {number}. {call.question}
      </h3>
      <div
        role="radiogroup"
        aria-labelledby={titleId}
        className="question__options"
      >
        {call.options.map((option, index) => {
          const checked = !own && choice.option === index;
          return (
            <button
              key={index}
              type="button"
              role="radio"
              aria-checked={checked}
              className={
                checked
                  ? 'question__option question__option--on'
                  : 'question__option'
              }
              onClick={() => onChange({ option: index, words: '' })}
            >
              <b>
                {option.label}
                {index === call.pick && ' (recommended)'}
              </b>
              {option.detail && (
                <span className="question__detail">{option.detail}</span>
              )}
            </button>
          );
        })}
      </div>
      {call.why && <p className="question__why">{call.why}</p>}
      <label htmlFor={wordsId} className="question__words">
        <span>Or answer in your own words</span>
      </label>
      <input
        id={wordsId}
        className="question__input"
        maxLength={call.wordsLimit}
        value={choice.words}
        onChange={(event) =>
          onChange({ option: choice.option, words: event.target.value })
        }
      />
      {error && (
        <span role="alert" className="setup__error">
          {error}
        </span>
      )}
    </section>
  );
}
