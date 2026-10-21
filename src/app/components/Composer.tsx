import {
  useId,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { ActOutcome } from '../api.ts';
import { afterSend } from '../intent.ts';
import { useAction } from '../useAction.ts';

/**
 * A box to write to the lab or an agent. After a send goes through, the box
 * empties only if it still holds what was sent: text typed meanwhile stays.
 * After a refusal or a lost answer the text stays, with the reason under the
 * box.
 *
 * `multiline`: a box of a few lines with its label shown above it, as for an
 * answer in the person's own words. Enter makes a new line there, and ⌘ or
 * Ctrl with Enter sends. `maxLength`: the server's limit, when it gave one;
 * without one a multiline box sets none and the server checks the length.
 * `hint`: one line under the box, such as when the message reaches its
 * reader. A refusal shows in its place.
 */
export function Composer({
  label,
  placeholder,
  onSend,
  multiline = false,
  maxLength,
  hint,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly onSend: (text: string, key: string) => Promise<ActOutcome>;
  readonly multiline?: boolean;
  readonly maxLength?: number | undefined;
  readonly hint?: string | undefined;
}): ReactNode {
  const id = useId();
  const [text, setText] = useState('');
  const action = useAction(onSend);
  const send = async (event: FormEvent | KeyboardEvent): Promise<void> => {
    event.preventDefault();
    const sent = text;
    const value = sent.trim();
    if (!value || action.busy) return;
    if (await action.submit(value))
      setText((current) => afterSend(current, sent));
  };
  const below = action.error ? (
    <span role="alert" className="composer__error">
      {action.error}
    </span>
  ) : (
    hint && <span className="composer__hint">{hint}</span>
  );
  if (multiline)
    return (
      <form
        className="composer composer--box"
        onSubmit={(event) => void send(event)}
      >
        <label htmlFor={id} className="composer__label">
          {label}
        </label>
        <div className="composer__row">
          <textarea
            id={id}
            className="composer__area"
            rows={2}
            placeholder={placeholder}
            value={text}
            {...(maxLength === undefined ? {} : { maxLength })}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
                void send(event);
            }}
          />
          <button
            type="submit"
            className="button composer__send"
            disabled={action.busy}
          >
            Send
          </button>
        </div>
        {below}
      </form>
    );
  return (
    <form className="composer" onSubmit={(event) => void send(event)}>
      <div className="composer__box">
        <label htmlFor={id} className="visually-hidden">
          {label}
        </label>
        <input
          id={id}
          className="composer__input"
          placeholder={placeholder}
          value={text}
          maxLength={maxLength ?? 4000}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="submit"
          className="button button--primary"
          disabled={action.busy}
        >
          Send
        </button>
      </div>
      {below}
    </form>
  );
}
