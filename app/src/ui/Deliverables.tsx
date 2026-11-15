import { useEffect, useId, useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';

import { messageOf } from '../api/client.ts';
import type { Api } from '../api/client.ts';
import type {
  AgentView,
  Deliverable,
  DeliverableDecision,
  DeliverableOffer,
} from '../api/types.ts';
import {
  MAX_DELIVERABLES,
  MAX_SENTENCE,
  deliverCounts,
  isNewSentence,
  offerLine,
  stateLine,
} from '../model/deliverables.ts';
import { href } from '../model/route.ts';
import { Who } from './Picture.tsx';

/**
 * The line under the answer that counts the deliverables by state. A press opens the panel beside the wall, and
 * another press closes it.
 */
export function DeliverDoor(props: {
  readonly list: readonly Deliverable[];
  readonly open: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={`d-door${props.open ? ' on' : ''}`}
      aria-expanded={props.open}
      onClick={props.onToggle}
    >
      <span className="f-label">Deliverables</span>
      {props.list.length === 0 ? (
        <span className="d-sum">You stated none</span>
      ) : (
        <span className="d-sum">
          {deliverCounts(props.list).map((item) => (
            <span key={item.label}>
              <b>{item.count}</b> {item.label}
            </span>
          ))}
        </span>
      )}
      <u>{props.open ? 'Close' : props.list.length === 0 ? 'Add' : 'Open'}</u>
    </button>
  );
}

/** What the panel needs: the API, the lab's agents, the time, and the way to read the lab again. */
interface Shared {
  readonly api: Api;
  readonly agents: readonly AgentView[];
  readonly now: Date;
  readonly reload: () => void;
}

/**
 * The panel for the deliverables, in the place where the panel for the coordinator docks. Each deliverable shows
 * the person's sentence, its one state, and the offers for it. Verifold judges no file: the person accepts an
 * offer, asks for changes, or takes an acceptance back. The foot adds a deliverable.
 */
export function Deliverables(
  props: Shared & { readonly list: readonly Deliverable[]; readonly onClose: () => void },
): ReactElement {
  const { api, list, reload } = props;
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    // The page makes room for the panel, as it does for the panel for the coordinator.
    document.body.classList.add('with-panel');
    return () => {
      document.body.classList.remove('with-panel');
    };
  }, []);
  const full = list.length >= MAX_DELIVERABLES;
  return (
    <aside className="k-panel d-panel" aria-label="Deliverables">
      <header>
        <div>
          <h2 className="d-title">Deliverables</h2>
          <p className="k-prov">
            What you want at the end of the lab. Every agent can read this list.
          </p>
        </div>
        <button type="button" className="linkbtn" onClick={props.onClose}>
          Close
        </button>
      </header>
      <ol className="d-list">
        {list.length === 0 ? (
          <li className="d-empty">
            You stated no deliverable. Say what you want to hold at the end, such as a one-page
            answer or a script that runs the result again. Agents offer files for it, and you accept
            them or ask for changes.
          </li>
        ) : null}
        {list.map((item) => (
          <Item key={item.id} item={item} {...props} />
        ))}
      </ol>
      <div className="d-foot">
        {adding ? (
          <LineForm
            label="A new deliverable"
            placeholder="Say what you want at the end, in one sentence"
            hint="The agents get a post about it."
            button="Add"
            ready={(text) => isNewSentence(text)}
            onSave={async (text) => {
              await api.addDeliverable(text);
              reload();
            }}
            onClose={() => {
              setAdding(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="d-add"
            disabled={full}
            onClick={() => {
              setAdding(true);
            }}
          >
            {full ? `A lab has ${MAX_DELIVERABLES} deliverables at most` : 'Add a deliverable'}
          </button>
        )}
      </div>
    </aside>
  );
}

/** One deliverable: the sentence, the state, each offer with its files and buttons, and the way to edit it. */
function Item(props: Shared & { readonly item: Deliverable }): ReactElement {
  const { api, item, reload } = props;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = (
    <button
      type="button"
      onClick={() => {
        setEditing(true);
      }}
    >
      Edit
    </button>
  );
  if (editing) {
    return (
      <li className={`d-${item.state}`}>
        <LineForm
          label="The deliverable"
          start={item.text}
          hint="The agents get a post about the change. The record keeps the earlier sentence."
          button="Save"
          ready={(text) => isNewSentence(text, item.text)}
          onSave={async (text) => {
            await api.changeDeliverable(item.id, text);
            reload();
          }}
          onRemove={async () => {
            await api.removeDeliverable(item.id);
            reload();
          }}
          onClose={() => {
            setEditing(false);
          }}
        />
      </li>
    );
  }
  return (
    <li className={`d-${item.state}`}>
      <p className="d-text">{item.text}</p>
      <p className="d-state">
        <i />
        {stateLine(item, props.now)}
      </p>
      {item.offers.map((offer, index) => (
        <OfferBlock
          key={offer.post}
          {...props}
          offer={offer}
          onError={setError}
          last={index === item.offers.length - 1 ? edit : null}
        />
      ))}
      {item.offers.length === 0 ? <p className="k-buttons">{edit}</p> : null}
      {item.thread ? (
        <p className="d-more">
          <a href={href({ page: 'thread', id: item.thread, post: null })}>
            Open the thread with every offer
          </a>
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * One agent's offer: its files, each of which opens as a page at the version that the agent offered, the agent's
 * note, and the person's buttons. `last` is the Edit button of the deliverable, which the last offer's row holds.
 */
function OfferBlock(
  props: Shared & {
    readonly item: Deliverable;
    readonly offer: DeliverableOffer;
    readonly last: ReactNode;
    readonly onError: (error: string | null) => void;
  },
): ReactElement {
  const { api, item, offer, reload } = props;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const line = offerLine(offer, props.agents, props.now);
  const decide = (decision: DeliverableDecision): void => {
    setBusy(true);
    props.onError(null);
    api
      .decideDeliverable(item.id, decision, offer.post)
      .then(reload, (failure: unknown) => {
        props.onError(messageOf(failure));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <div className={`d-offer${offer.accepted && item.offers.length > 1 ? ' took' : ''}`}>
      {offer.files.map((path) => (
        <div key={path} className="d-file">
          <Who agents={props.agents} id={offer.by} size={22} dot={false} />
          <span>
            <code>{path}</code>
            <small>{line}</small>
          </span>
          <a href={href({ page: 'file', post: offer.post, path })} aria-label={`Read ${path}`}>
            Read
          </a>
        </div>
      ))}
      <p className="d-note">{offer.note}</p>
      {asking ? (
        <LineForm
          label="What to change"
          placeholder="Say what you want changed"
          hint="The agent gets it as a reply to its offer."
          button="Ask for changes"
          most={1000}
          ready={(text) => isNewSentence(text)}
          onSave={async (text) => {
            await api.decideDeliverable(item.id, 'ask_changes', offer.post, text);
            reload();
          }}
          onClose={() => {
            setAsking(false);
          }}
        />
      ) : (
        <p className="k-buttons">
          {offer.accepted ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                decide('take_back');
              }}
            >
              Take the acceptance back
            </button>
          ) : (
            <>
              <button
                type="button"
                className={item.state === 'accepted' ? undefined : 'go'}
                disabled={busy}
                onClick={() => {
                  decide('accept');
                }}
              >
                {item.state === 'accepted' ? 'Accept this one instead' : 'Accept'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setAsking(true);
                }}
              >
                Ask for changes
              </button>
            </>
          )}
          {props.last}
        </p>
      )}
    </div>
  );
}

/**
 * A form of one text box: a new deliverable, a new sentence for one, or what to change in an offer. The button
 * is off until `ready` says that the text can go. `onClose` runs after a save and on Cancel. With `onRemove`, the
 * form also removes the deliverable.
 */
function LineForm(props: {
  readonly label: string;
  readonly start?: string;
  readonly placeholder?: string;
  readonly hint: string;
  readonly button: string;
  /** The most characters that the box takes. A deliverable's sentence has the default. */
  readonly most?: number;
  readonly ready: (text: string) => boolean;
  readonly onSave: (text: string) => Promise<void>;
  readonly onRemove?: () => Promise<void>;
  readonly onClose: () => void;
}): ReactElement {
  const [text, setText] = useState(props.start ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const ready = props.ready(text) && !busy;
  const run = (work: Promise<void>): void => {
    setBusy(true);
    setError(null);
    work.then(props.onClose, (failure: unknown) => {
      setError(messageOf(failure));
      setBusy(false);
    });
  };
  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (ready) run(props.onSave(text.trim()));
  };
  return (
    <form className="d-form" onSubmit={save}>
      <label htmlFor={id}>{props.label}</label>
      <textarea
        id={id}
        rows={2}
        value={text}
        maxLength={props.most ?? MAX_SENTENCE}
        placeholder={props.placeholder}
        // The form opens on the person's press, so the box takes the keyboard.
        autoFocus
        onChange={(event) => {
          // A deliverable is one line. A pasted line break becomes a space.
          setText(event.target.value.replace(/\s*\n\s*/g, ' '));
        }}
      />
      <div>
        <span className={error ? 'error' : undefined} role={error ? 'alert' : undefined}>
          {error ?? props.hint}
        </span>
        {props.onRemove ? (
          <button
            type="button"
            className="linkbtn"
            disabled={busy}
            onClick={() => {
              if (props.onRemove) run(props.onRemove());
            }}
          >
            Remove
          </button>
        ) : null}
        <button type="button" className="linkbtn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="submit" disabled={!ready}>
          {busy ? 'Saving' : props.button}
        </button>
      </div>
    </form>
  );
}
