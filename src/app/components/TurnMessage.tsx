import { useState, type ReactNode } from 'react';
import type { Text } from '../../protocol/api.ts';

/** A message longer than this folds after a few lines. */
const longText = 400;
const longLines = 5;

/**
 * An agent's last message in a turn. A long one folds after a few lines,
 * with "Show all". When the server cut it, the turn's page has the rest.
 */
export function TurnMessage({
  message,
  rest,
}: {
  readonly message: Text;
  /** The turn's page, or null on that page itself. */
  readonly rest: string | null;
}): ReactNode {
  const [all, setAll] = useState(false);
  const long =
    message.text.length > longText ||
    message.text.split('\n').length > longLines;
  return (
    <div className="turn__message">
      <p
        className={
          long && !all ? 'turn__text turn__text--folded' : 'turn__text'
        }
      >
        {message.text}
      </p>
      {long && (
        <button
          type="button"
          className="link-button"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
      {message.trimmed && rest && (!long || all) && (
        <a href={rest}>The rest of this message is on the turn's page</a>
      )}
    </div>
  );
}
