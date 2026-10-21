import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { ActOutcome } from '../api.ts';
import { afterSend } from '../intent.ts';
import { useAction } from '../useAction.ts';

/**
 * A one-line box to write to the lab or an agent. After a send goes
 * through, the box empties only if it still holds what was sent: text typed
 * meanwhile stays. After a refusal or a lost answer the text stays, with the
 * reason under the box.
 */
export function Composer({
  label,
  placeholder,
  onSend,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly onSend: (text: string, key: string) => Promise<ActOutcome>;
}): ReactNode {
  const id = useId();
  const [text, setText] = useState('');
  const action = useAction(onSend);
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const sent = text;
    const value = sent.trim();
    if (!value || action.busy) return;
    if (await action.submit(value))
      setText((current) => afterSend(current, sent));
  };
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
          maxLength={4000}
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
      {action.error && (
        <span role="alert" className="composer__error">
          {action.error}
        </span>
      )}
    </form>
  );
}
