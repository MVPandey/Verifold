import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { ActOutcome } from '../api.ts';
import { afterSend } from '../intent.ts';
import {
  enterCompletes,
  insertMention,
  mentionMatches,
  mentionQuery,
  type MentionName,
} from '../mentions.ts';
import { useAction } from '../useAction.ts';
import { Cross } from './Icons.tsx';

/** What a send is: the text, and the post that it answers, or null. */
export interface Send {
  readonly text: string;
  readonly to: string | null;
}

/** Two sends are one intent when both the text and the post that they answer are the same. */
export function sameSend(a: Send, b: Send): boolean {
  return a.text === b.text && a.to === b.to;
}

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
 * reader. A refusal shows in its place. `names`: the names that the
 * one-line box completes after an `@`, with the arrow keys and Tab, or Enter
 * while the person typed only the start of a name. `replying`: the post that
 * a send answers, shown above the box with a way to stop replying. A send
 * to another post is another intent, with its own key. `onSent` runs after
 * a send went through.
 */
export function Composer({
  label,
  placeholder,
  onSend,
  multiline = false,
  maxLength,
  hint,
  names,
  replying,
  onSent,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly onSend: (text: string, key: string) => Promise<ActOutcome>;
  readonly multiline?: boolean;
  readonly maxLength?: number | undefined;
  readonly hint?: string | undefined;
  readonly names?: readonly MentionName[] | undefined;
  readonly replying?:
    | {
        /** The post's ID. */
        readonly post: string;
        /** Who wrote it. */
        readonly to: string;
        readonly text: string;
        readonly onStop: () => void;
      }
    | undefined;
  readonly onSent?: (() => void) | undefined;
}): ReactNode {
  const id = useId();
  const listId = useId();
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Escape closes the list until the person types again.
  const [closed, setClosed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Where the caret goes after a name comes in, once the box shows the new text.
  const moveTo = useRef<number | null>(null);
  useEffect(() => {
    if (moveTo.current === null || !input.current) return;
    input.current.setSelectionRange(moveTo.current, moveTo.current);
    moveTo.current = null;
  }, [text]);
  const action = useAction<Send>(
    (value, key) => onSend(value.text, key),
    sameSend,
  );
  const send = async (event: FormEvent | KeyboardEvent): Promise<void> => {
    event.preventDefault();
    const sent = text;
    const value = sent.trim();
    if (!value || action.busy) return;
    if (await action.submit({ text: value, to: replying?.post ?? null })) {
      setText((current) => afterSend(current, sent));
      onSent?.();
    }
  };
  const query = names && !closed ? mentionQuery(text, caret) : null;
  const matches = names && query ? mentionMatches(names, query.query) : [];
  const listing = matches.length > 0;
  const chosen = Math.min(active, matches.length - 1);
  const complete = (name: MentionName): void => {
    if (!query) return;
    const next = insertMention(text, query.start, caret, name.value);
    moveTo.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setActive(0);
  };
  const type = (value: string, at: number | null): void => {
    setText(value);
    setCaret(at ?? value.length);
    setActive(0);
    setClosed(false);
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
      {replying && (
        <p className="composer__replying">
          <span>
            Replying to <b>{replying.to}</b>: {replying.text}
          </span>
          <button
            type="button"
            className="composer__stop"
            aria-label="Stop replying"
            onClick={replying.onStop}
          >
            <Cross size={14} />
          </button>
        </p>
      )}
      <div className="composer__box">
        <label htmlFor={id} className="visually-hidden">
          {label}
        </label>
        <input
          ref={input}
          id={id}
          className="composer__input"
          placeholder={placeholder}
          value={text}
          maxLength={maxLength ?? 4000}
          {...(names
            ? {
                role: 'combobox',
                'aria-autocomplete': 'list' as const,
                'aria-expanded': listing,
                'aria-controls': listId,
                ...(listing
                  ? { 'aria-activedescendant': `${listId}-${chosen}` }
                  : {}),
              }
            : {})}
          onChange={(event) =>
            type(event.target.value, event.target.selectionStart)
          }
          onSelect={(event) =>
            setCaret(event.currentTarget.selectionStart ?? text.length)
          }
          onKeyDown={(event) => {
            if (!listing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((chosen + step + matches.length) % matches.length);
            } else if (event.key === 'Enter' || event.key === 'Tab') {
              const name = matches[chosen];
              if (!name || !query) return;
              // When the person typed a whole name, Enter sends the message.
              if (event.key === 'Enter' && !enterCompletes(query.query, name))
                return;
              event.preventDefault();
              complete(name);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setClosed(true);
            }
          }}
        />
        <button
          type="submit"
          className="button button--primary"
          disabled={action.busy}
        >
          Send
        </button>
      </div>
      {names && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Names"
          className="mentions"
          hidden={!listing}
        >
          {matches.map((name, index) => (
            <li
              key={name.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === chosen}
              className={
                index === chosen ? 'mentions__item is-active' : 'mentions__item'
              }
              // A press keeps the focus in the box, so the name comes in where the person types.
              onMouseDown={(event) => {
                event.preventDefault();
                complete(name);
              }}
            >
              <b>{name.value}</b> <span className="muted">{name.note}</span>
            </li>
          ))}
        </ul>
      )}
      {below}
    </form>
  );
}
