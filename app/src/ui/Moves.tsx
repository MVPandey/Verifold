import { useId, useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';

import type { Api } from '../api/client.ts';
import { messageOf } from '../api/client.ts';
import type {
  AgentView,
  ConversationView,
  HarnessOption,
  MoveView,
  SeatChoice,
} from '../api/types.ts';
import { clock } from '../model/format.ts';
import { MOVES_IN_SIGHT, grantLine, kindLine, moveWords, sameKind } from '../model/moves.ts';
import { href } from '../model/route.ts';
import { Exact } from './parts.tsx';

/**
 * The log of the coordinator's moves, newest first: when each took effect, what it did in the app's words, the
 * agent's own text that it holds, and its one line of why. `extra` adds a part under a move, such as its way back.
 */
export function MovesList(props: {
  readonly moves: readonly MoveView[];
  readonly agents: readonly AgentView[];
  readonly extra?: (move: MoveView) => ReactNode;
  /**
   * Whether each move is one line that opens to its words and its why, with no link to its post, as beside the chat,
   * where the panel has the links.
   */
  readonly compact?: boolean;
}): ReactElement {
  if (props.compact) {
    // Beside the chat, each move is one line, and its words and its why open under it.
    return (
      <ul className="m-list m-compact">
        {props.moves.map((move) => {
          const words = moveWords(move, props.agents);
          return (
            <li key={move.post.post.id}>
              <details>
                <summary>
                  <time dateTime={move.at}>{clock(move.at)}</time>
                  <span className="m-what">
                    {words.what}
                    {words.seat ? (
                      <>
                        {' · '}
                        <b className="m-name">{words.seat}</b>
                      </>
                    ) : null}
                    {move.post.standing === 'disputed' ? (
                      <span className="m-mark">An agent objects</span>
                    ) : null}
                  </span>
                </summary>
                {words.theirs ? <p className="m-theirs">{words.theirs}</p> : null}
                {words.why ? (
                  <p className="m-why">
                    Why: <span className="m-text">{words.why}</span>
                  </p>
                ) : null}
              </details>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ul className="m-list">
      {props.moves.map((move) => {
        const words = moveWords(move, props.agents);
        const { post } = move.post;
        return (
          <li key={post.id}>
            <time dateTime={move.at}>{clock(move.at)}</time>
            <div>
              <p className="m-what">
                {words.what}
                {words.seat ? (
                  <>
                    {' · '}
                    <b className="m-name">{words.seat}</b>
                  </>
                ) : null}
                {move.post.standing === 'disputed' ? (
                  <span className="m-mark">An agent objects</span>
                ) : null}
              </p>
              {words.theirs ? <p className="m-theirs">{words.theirs}</p> : null}
              {words.why ? (
                <p className="m-why">
                  Why: <span className="m-text">{words.why}</span>
                </p>
              ) : null}
              {props.compact ? null : (
                <a href={href({ page: 'thread', id: post.thread, post: post.id })}>
                  See it in its thread
                </a>
              )}
              {props.extra ? props.extra(move) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The coordinator's newest moves beside the chat on the lab page, with the way to the whole log. With no
 * coordinator and no move, it shows nothing.
 */
export function MovesCard(props: {
  readonly moves: readonly MoveView[];
  readonly agents: readonly AgentView[];
  readonly seated: boolean;
  readonly onAll: () => void;
}): ReactElement | null {
  const { moves } = props;
  if (!props.seated && moves.length === 0) return null;
  return (
    <section className="m-card" aria-labelledby="moves-title">
      <h2 id="moves-title" className="kicker">
        The coordinator’s moves
      </h2>
      {moves.length === 0 ? (
        <p className="m-none">No move yet. Each move shows here with its one line of why.</p>
      ) : (
        <MovesList moves={moves.slice(0, MOVES_IN_SIGHT)} agents={props.agents} compact />
      )}
      {moves.length > 0 ? (
        <button type="button" className="linkbtn" onClick={props.onAll}>
          {moves.length > MOVES_IN_SIGHT
            ? `See all ${String(moves.length)} moves`
            : 'See the moves'}
        </button>
      ) : null}
    </section>
  );
}

const DEFAULT = '';

/**
 * The person's grant of spare seats: how many agents the coordinator may add by itself, and of which kinds. A kind
 * is a harness with its model, effort, and mode, chosen from what the harness offers. A new grant replaces the
 * one that stands, and the person takes it back with zero seats.
 */
export function SpareSeatsForm(props: {
  readonly api: Api;
  readonly view: ConversationView;
  readonly harnesses: readonly HarnessOption[];
  readonly name: string;
  readonly reload: () => void;
}): ReactElement {
  const { view, harnesses, name } = props;
  const grant = view.grant ?? null;
  const offered = harnesses.filter((harness) => harness.available);
  const [seats, setSeats] = useState(grant ? String(grant.of) : '1');
  const [kinds, setKinds] = useState<readonly SeatChoice[]>(grant ? grant.kinds : []);
  const [harness, setHarness] = useState(offered[0]?.name ?? DEFAULT);
  const [model, setModel] = useState(DEFAULT);
  const [effort, setEffort] = useState(DEFAULT);
  const [mode, setMode] = useState(DEFAULT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { seats: useId(), harness: useId(), model: useId(), effort: useId(), mode: useId() };
  const offer = offered.find((option) => option.name === harness)?.offer ?? null;
  const efforts =
    offer?.models.find((item) => item.value === model)?.efforts ?? offer?.efforts ?? [];
  const count = Number(seats);
  const valid = Number.isInteger(count) && count >= 1 && count <= 20 && kinds.length > 0;
  const send = (seatsNow: number, choices: readonly SeatChoice[]): void => {
    setBusy(true);
    setError(null);
    props.api.grantSeats({ seats: seatsNow, choices }).then(
      () => {
        setBusy(false);
        props.reload();
      },
      (failure: unknown) => {
        setError(messageOf(failure));
        setBusy(false);
      },
    );
  };
  const add = (): void => {
    if (!harness) return;
    const kind: SeatChoice = {
      harness,
      model: model || null,
      effort: effort || null,
      mode: mode || null,
    };
    if (!kinds.some((known) => sameKind(known, kind))) setKinds([...kinds, kind]);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (valid) send(count, kinds);
  };
  const choose = (
    id: string,
    label: string,
    value: string,
    set: (value: string) => void,
    options: readonly { value: string; name: string }[],
  ): ReactElement => (
    <p className="g-pick">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          set(event.target.value);
        }}
      >
        <option value={DEFAULT}>The harness’s default</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.name}
          </option>
        ))}
      </select>
    </p>
  );
  return (
    <form className="g-grant" onSubmit={submit} aria-labelledby={`${ids.seats}-title`}>
      <h3 id={`${ids.seats}-title`}>Spare seats</h3>
      <p className="g-line">{grantLine(grant, name)}</p>
      <p className="g-lede">
        Inside the grant, {name} adds an agent of these kinds at once, with one line of why in its
        moves. Outside it, {name} asks you. Only you remove an agent.
      </p>
      <p className="g-pick">
        <label htmlFor={ids.seats}>Seats</label>
        <input
          id={ids.seats}
          type="number"
          min={1}
          max={20}
          value={seats}
          onChange={(event) => {
            setSeats(event.target.value);
          }}
        />
      </p>
      <p className="g-pick">
        <label htmlFor={ids.harness}>Harness</label>
        <select
          id={ids.harness}
          value={harness}
          onChange={(event) => {
            setHarness(event.target.value);
            setModel(DEFAULT);
            setEffort(DEFAULT);
            setMode(DEFAULT);
          }}
        >
          {offered.map((option) => (
            <option key={option.name} value={option.name}>
              {option.title}
            </option>
          ))}
        </select>
      </p>
      {choose(ids.model, 'Model', model, setModel, offer?.models ?? [])}
      {choose(ids.effort, 'Effort', effort, setEffort, efforts)}
      {choose(ids.mode, 'Mode', mode, setMode, offer?.modes ?? [])}
      <p className="k-buttons">
        <button type="button" disabled={!harness} onClick={add}>
          Add this kind
        </button>
      </p>
      {kinds.length > 0 ? (
        <ul className="g-kinds" aria-label="Kinds of seat in the grant">
          {kinds.map((kind) => (
            <li key={kindLine(kind, harnesses)}>
              <span>{kindLine(kind, harnesses)}</span>
              <button
                type="button"
                className="linkbtn"
                onClick={() => {
                  setKinds(kinds.filter((known) => !sameKind(known, kind)));
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="g-none">Add at least one kind of seat.</p>
      )}
      <p className="k-buttons">
        <button type="submit" className="go" disabled={busy || !valid}>
          Grant {valid ? `${String(count)} ${count === 1 ? 'seat' : 'seats'}` : 'seats'}
        </button>
        {grant ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              send(0, []);
            }}
          >
            Take the grant back
          </button>
        ) : null}
      </p>
      {error ? (
        <div className="k-refused" role="alert">
          <p className="error">Verifold did not do this.</p>
          <Exact label="What the server said" text={error} />
        </div>
      ) : null}
    </form>
  );
}
