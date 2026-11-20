import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { messageOf } from '../api/client.ts';
import type { AgentView, PostRequest, RoundView } from '../api/types.ts';
import { authorName } from '../model/agents.ts';
import { href } from '../model/route.ts';
import { ROUND_MINUTES, enteredLine, roundRequest, roundRows, roundTime } from '../model/rounds.ts';
import { Detail } from './Markdown.tsx';

const CHOICES = Array.from(
  { length: ROUND_MINUTES.most - ROUND_MINUTES.least + 1 },
  (_, index) => ROUND_MINUTES.least + index,
);

/**
 * The control beside the box that steers the lab, which opens a round: the question and the minutes that the round
 * stays open. A lab has one open round at a time, so while one is open the control says until when.
 */
export function RoundOpener(props: {
  readonly round: RoundView | null;
  readonly now: Date;
  readonly onOpen: (request: PostRequest) => Promise<void>;
}): ReactElement {
  const [shown, setShown] = useState(false);
  const [text, setText] = useState('');
  const [minutes, setMinutes] = useState<number>(ROUND_MINUTES.first);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  if (props.round?.open) {
    return <p className="f-round-note">A round is open. {roundTime(props.round, props.now)}.</p>;
  }
  if (!shown) {
    return (
      <button
        type="button"
        className="linkbtn f-round-toggle"
        onClick={() => {
          setShown(true);
        }}
      >
        Ask every agent at once
      </button>
    );
  }
  const request = roundRequest(text, minutes);
  const open = (event: FormEvent): void => {
    event.preventDefault();
    if (!request || sending) return;
    setSending(true);
    setError(null);
    props.onOpen(request).then(
      () => {
        setText('');
        setSending(false);
        setShown(false);
      },
      (failure: unknown) => {
        setError(messageOf(failure));
        setSending(false);
      },
    );
  };
  return (
    <form className="f-round-form" onSubmit={open}>
      <label htmlFor={`${id}-question`}>Ask every agent at once</label>
      <input
        id={`${id}-question`}
        value={text}
        placeholder="What is your best bet now?"
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <div className="f-round-row">
        <label htmlFor={`${id}-minutes`}>Open for</label>
        <select
          id={`${id}-minutes`}
          value={minutes}
          onChange={(event) => {
            setMinutes(Number(event.target.value));
          }}
        >
          {CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice} min
            </option>
          ))}
        </select>
        <button
          type="button"
          className="linkbtn"
          onClick={() => {
            setShown(false);
          }}
        >
          Cancel
        </button>
        <button type="submit" disabled={!request || sending}>
          {sending ? 'Opening' : 'Open the round'}
        </button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : (
        <p className="f-round-hint">
          No agent sees another agent’s answer until the round closes. You see each answer as it
          comes.
        </p>
      )}
    </form>
  );
}

/**
 * The lab's newest round, above the thread cards: the open one, or else the one that closed last. It has the
 * question, who asked it, when it closes or closed, and how many agents entered. One table holds a row for each
 * agent: the headline of its entry with the detail behind the control of a post's detail, or that it has not
 * entered. The person sees each entry as it arrives, also while the agents do not.
 */
export function RoundPanel(props: {
  readonly round: RoundView | null;
  readonly agents: readonly AgentView[];
  readonly now: Date;
}): ReactElement | null {
  const view = props.round;
  if (view === null) return null;
  const { post } = view.round;
  return (
    <section className="f-round" aria-labelledby="round-title">
      <div className="f-round-head">
        <h2 id="round-title">{view.open ? 'Open round' : 'Last round'}</h2>
        <span className="f-by">
          {authorName(props.agents, post.author)} asked · {roundTime(view, props.now)} ·{' '}
          {enteredLine(view)}
        </span>
        <a href={href({ page: 'thread', id: post.thread, post: post.id })}>See it in its thread</a>
      </div>
      <p className="f-round-text">{post.text}</p>
      {/* The entries fold under the question, and the line above counts them. */}
      <details className="f-round-entries">
        <summary>
          <span className="closed">Show the entries</span>
          <span className="opened">Hide the entries</span>
        </summary>
        <table className="f-round-table">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Entry</th>
            </tr>
          </thead>
          <tbody>
            {roundRows(view).map((row) => (
              <tr key={row.agent}>
                <th scope="row">{authorName(props.agents, row.agent)}</th>
                <td>
                  {row.entry ? (
                    <>
                      <p>{row.entry.post.text}</p>
                      <Detail
                        post={row.entry.post.id}
                        body={row.entry.post.body}
                        files={row.entry.post.evidence}
                      />
                    </>
                  ) : (
                    <span className="dim">{view.open ? 'Not entered yet' : 'No entry'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
