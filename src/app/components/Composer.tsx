import { useId, useState, type FormEvent, type ReactNode } from 'react';

/**
 * A one-line box to write to the lab or an agent. `onSend` resolves to
 * Verifold's reason when it refused the message. The text stays then.
 */
export function Composer({
  label,
  placeholder,
  note,
  onSend,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly note?: string;
  readonly onSend: (text: string) => Promise<string | null>;
}): ReactNode {
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    const refused = await onSend(value);
    setBusy(false);
    setError(refused);
    if (!refused) setText('');
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
          disabled={busy}
        >
          Send
        </button>
      </div>
      {error ? (
        <span role="alert" className="composer__error">
          {error}
        </span>
      ) : (
        note && <span className="composer__note">{note}</span>
      )}
    </form>
  );
}
