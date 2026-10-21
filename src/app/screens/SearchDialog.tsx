import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  searchQueryLimit,
  type Lab,
  type SearchHit,
  type SearchResult,
  type SnippetPart,
} from '../../protocol/api.ts';
import type { Loaded } from '../api.ts';
import { clock } from '../format.ts';
import { callRead, hitAction, nextHit, type HitAction } from '../search.ts';
import { Cross } from '../components/Icons.tsx';

/** The words of the last search. They last for this tab, as on the desk. */
const queryKey = 'verifold-app-q';

function readQuery(): string {
  try {
    return sessionStorage.getItem(queryKey) ?? '';
  } catch {
    return '';
  }
}

function saveQuery(q: string): void {
  try {
    if (q) sessionStorage.setItem(queryKey, q);
    else sessionStorage.removeItem(queryKey);
  } catch {
    // A tab that keeps no storage, such as a private window, forgets the words.
  }
}

/** A hit's text with its matches marked. */
function Snippet({
  parts,
}: {
  readonly parts: readonly SnippetPart[];
}): ReactNode {
  return (
    <>
      {parts.map((part, index) =>
        part.mark ? (
          <mark key={index}>{part.text}</mark>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

/** A hit's first line: its kind, ID, author, time, and where it stands. */
function HitHead({ hit }: { readonly hit: SearchHit }): ReactNode {
  const chip =
    hit.type === 'post'
      ? { label: hit.label, kind: hit.kind }
      : hit.type === 'run'
        ? { label: 'Run', kind: 'run' }
        : { label: hit.label, kind: 'call' };
  const state = hit.type === 'post' ? null : hit.summary;
  return (
    <span className="hit__head">
      <span className={`chip chip--${chip.kind}`}>{chip.label}</span>
      <span>
        <b>{hit.id}</b> · {hit.author} ·{' '}
        <time dateTime={hit.at}>{clock(hit.at)}</time>
        {state && ` · ${state}`}
      </span>
    </span>
  );
}

function HitText({ hit }: { readonly hit: SearchHit }): ReactNode {
  return hit.type === 'run' ? (
    <code className="hit__text hit__text--code">
      <Snippet parts={hit.snippet} />
    </code>
  ) : (
    <span className="hit__text">
      <Snippet parts={hit.snippet} />
    </span>
  );
}

/**
 * One hit. A hit that opens a page is a link: Enter or a click goes there
 * and closes the search. A link opened in a new tab leaves the search open
 * here. A call that the snapshot leaves out shows its question and answer
 * here instead.
 */
export function Hit({
  hit,
  action,
  open,
  onGo,
  onRead,
}: {
  readonly hit: SearchHit;
  readonly action: HitAction;
  readonly open: boolean;
  readonly onGo: () => void;
  readonly onRead: () => void;
}): ReactNode {
  if (action.type === 'go')
    return (
      <li className="hit">
        <a
          className="hit__open"
          href={action.route}
          data-hit=""
          onClick={(event: MouseEvent) => {
            if (
              event.button === 0 &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey
            )
              onGo();
          }}
        >
          <HitHead hit={hit} />
          <HitText hit={hit} />
        </a>
      </li>
    );
  return (
    <li className="hit">
      <button
        type="button"
        className="hit__open"
        data-hit=""
        aria-expanded={open}
        onClick={onRead}
      >
        <HitHead hit={hit} />
        <HitText hit={hit} />
        <span className="hit__more">
          {open ? 'Hide the call' : 'Show the call'}
        </span>
      </button>
      {open && hit.type === 'call' && (
        <div className="hit__read">
          <p className="hit__whole">{hit.question}</p>
          <p className="hit__fine">{callRead(hit)}</p>
        </div>
      )}
    </li>
  );
}

/**
 * The search of the lab, over any page: posts, runs, and calls, the newest
 * first, as the desk's search panel finds them. ⌘K or Ctrl+K and the
 * header's Search button open it, and Escape closes it. The arrow keys move
 * between the box and the hits. Where a hit opens depends on what `lab`,
 * the page's snapshot, holds. The search closes as a dialog does, so the
 * browser gives the focus back to where it was. A hit's page then takes
 * it, after it renders.
 */
export function SearchDialog({
  lab,
  run,
  onClose,
}: {
  readonly lab: Lab;
  readonly run: (
    q: string,
    signal: AbortSignal,
  ) => Promise<Loaded<SearchResult>>;
  readonly onClose: () => void;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const titleId = useId();
  const inputId = useId();
  const noteId = useId();
  const [q, setQ] = useState(readQuery);
  const [result, setResult] = useState<Loaded<SearchResult> | null>(null);
  const [read, setRead] = useState<string | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    // showModal() gives focus to the dialog's first control, the close button: the box takes it.
    // The last words stay for this tab, selected, so new typing replaces them.
    input.current?.focus();
    input.current?.select();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  useEffect(() => {
    saveQuery(q);
    const words = q.trim();
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        void run(words, controller.signal).then((loaded) => {
          if (!controller.signal.aborted) {
            setResult(loaded);
            setRead(null);
          }
        });
      },
      words ? 200 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, run]);
  const close = (): void => ref.current?.close();
  const keys = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [
      ...(list.current?.querySelectorAll<HTMLElement>('[data-hit]') ?? []),
    ];
    const at = items.findIndex((item) => item === document.activeElement);
    const next = nextHit(at, items.length, event.key);
    if (next === at) return;
    event.preventDefault();
    (next < 0 ? input.current : items[next])?.focus();
  };
  const found = result && 'value' in result ? result.value : null;
  const note = !result
    ? 'Searching…'
    : 'error' in result
      ? result.error
      : result.value.note;
  return (
    <dialog
      ref={ref}
      className="search"
      aria-labelledby={titleId}
      aria-modal="true"
      onKeyDown={keys}
      onClose={onClose}
    >
      <div className="search__top">
        <h2 id={titleId} className="search__title">
          Search the lab
        </h2>
        <button
          type="button"
          className="button search__close"
          aria-label="Close the search"
          onClick={close}
        >
          <Cross size={18} width={2} />
        </button>
      </div>
      <label className="search__label" htmlFor={inputId}>
        Posts, runs, and calls
      </label>
      <input
        ref={input}
        id={inputId}
        className="search__input"
        type="search"
        maxLength={searchQueryLimit}
        autoComplete="off"
        spellCheck={false}
        value={q}
        onChange={(event) => setQ(event.target.value)}
        aria-describedby={noteId}
      />
      <p id={noteId} className="search__note" role="status">
        {note}
      </p>
      {found && found.hits.length > 0 && (
        <ol ref={list} className="hits" aria-label="Hits">
          {found.hits.map((hit) => (
            <Hit
              key={`${hit.type}:${hit.id}`}
              hit={hit}
              action={hitAction(hit, lab)}
              open={read === hit.id}
              onGo={close}
              onRead={() => setRead(read === hit.id ? null : hit.id)}
            />
          ))}
        </ol>
      )}
    </dialog>
  );
}
