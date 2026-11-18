import { Fragment, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import { messageOf } from '../api/client.ts';
import { PERSON } from '../api/types.ts';
import type {
  AgentView,
  ConversationView,
  Deed,
  HarnessOption,
  LabView,
  PostView,
  Power,
  ThreadSummary,
} from '../api/types.ts';
import { authorName, memberLine } from '../model/agents.ts';
import {
  POWER_WORDS,
  askLine,
  coordinatorOf,
  decidedLine,
  deedOf,
  details,
  doneLine,
  endedLine,
  heardLine,
  minutesOf,
  powerLine,
  reportLine,
  requestState,
  tabs,
  talkLabel,
  undoLabel,
  wakes,
  yesLabel,
} from '../model/coordinator.ts';
import type { Around, Detail, Tab } from '../model/coordinator.ts';
import { clock } from '../model/format.ts';
import { personAnswer, split } from '../model/posts.ts';
import { href } from '../model/route.ts';
import type { PageProps } from './hooks.ts';
import { halted } from '../model/limits.ts';
import { Words } from './Markdown.tsx';
import { Exact, HarnessAsk } from './parts.tsx';
import { Name, Who } from './Picture.tsx';

const NO_VIEW: ConversationView = {
  coordinator: null,
  thread: null,
  waits: [],
  no_reply: [],
  asks: [],
  powers: [],
  deeds: [],
};

/** What every part of the panel needs: the API, the lab's agents, and the way to read the lab again. */
interface Shared extends Around {
  readonly api: Api;
  readonly view: ConversationView;
  readonly reload: () => void;
}

/**
 * The coordinator's place in the seat of the lab page: who holds the seat, and the button that opens the
 * conversation beside the wall. With no coordinator, it says so.
 */
export function CoordinatorSeat(
  props: PageProps & {
    /** The tab of the panel that shows, or `null` while the panel is closed. The page has one docked panel at a time. */
    readonly tab: Tab | null;
    readonly onTab: (tab: Tab | null) => void;
  },
): ReactElement {
  const { api, data, tab } = props;
  const setTab = props.onTab;
  const holder = coordinatorOf(data.lab.agents);
  const open = holder !== null && tab !== null;
  if (holder === null) {
    return (
      <p className="k-empty">
        <b>No agent holds the coordinator seat.</b> Give the seat to an agent in the member list, or
        write to the whole lab here.
      </p>
    );
  }
  const view = data.conversation ?? NO_VIEW;
  const name = holder.agent.name;
  return (
    <div className="k-door">
      <p className="k-door-head">
        <Who agents={data.lab.agents} id={holder.agent.id} size={34} />
        <Name view={holder} />
        <span className="i-seat coord">Coordinator</span>
      </p>
      <button
        type="button"
        className="k-open"
        aria-expanded={open}
        onClick={() => {
          setTab(open ? null : 'talk');
        }}
      >
        {open ? 'Close the conversation' : talkLabel(name, view.waits.length)}
      </button>
      {tab === null ? null : (
        <Panel
          api={api}
          view={view}
          holder={holder}
          lab={data.lab}
          harnesses={data.setup?.harnesses ?? []}
          report={data.report}
          now={props.now}
          tab={tab}
          onTab={setTab}
          reload={data.reload}
        />
      )}
    </div>
  );
}

/** The panel for the coordinator: the conversation, what the coordinator may do, and what it did for the person. */
export function Panel(props: {
  readonly api: Api;
  readonly view: ConversationView;
  readonly holder: AgentView;
  readonly lab: LabView;
  readonly harnesses: readonly HarnessOption[];
  /** The newest report of any agent, which the conversation names above its posts. */
  readonly report?: PostView | null;
  readonly now: Date;
  readonly tab: Tab;
  readonly onTab: (tab: Tab | null) => void;
  readonly reload: () => void;
}): ReactElement {
  const { view, holder, tab, lab } = props;
  const name = holder.agent.name;
  // Out of time, at a limit, or closed, no agent works, and the line under the name says so.
  const resting = halted(lab) || lab.state === 'closed';
  const shared: Shared = {
    api: props.api,
    view,
    lab,
    harnesses: props.harnesses,
    asks: view.asks,
    now: props.now,
    reload: props.reload,
  };
  return (
    <aside className="k-panel" aria-label={`${name}, the coordinator`}>
      <header>
        <Who agents={lab.agents} id={holder.agent.id} size={38} />
        <div>
          <p className="k-title">
            <Name view={holder} />
            <span className="i-seat coord">Coordinator</span>
          </p>
          <p className="k-prov">{memberLine(holder, resting, props.now).text}</p>
        </div>
        <button
          type="button"
          className="linkbtn"
          onClick={() => {
            props.onTab(null);
          }}
        >
          Close
        </button>
      </header>
      <nav aria-label="The panel for the coordinator">
        {tabs(name, view.waits.length).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => {
              props.onTab(key);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'talk' ? (
        <Talk {...shared} holder={holder} report={props.report ?? null} onTab={props.onTab} />
      ) : null}
      {tab === 'powers' ? <Powers {...shared} name={name} /> : null}
      {tab === 'log' ? <Log {...shared} /> : null}
    </aside>
  );
}

/** The width at which the panel covers the wall, as the panel's styles have it. */
const COVERS = '(max-width: 1000px)';

/**
 * The conversation: a line that names the newest report, one row for each post, and the box where the person
 * writes to the coordinator. Under the person's newest message, a line says where that message is until the
 * coordinator replies.
 */
function Talk(
  props: Shared & {
    readonly holder: AgentView;
    readonly report: PostView | null;
    readonly onTab: (tab: Tab | null) => void;
  },
): ReactElement {
  const { holder, report } = props;
  const name = holder.agent.name;
  const posts = props.view.thread?.posts ?? [];
  const heard = heardLine(props.view, props.lab, props.now);
  return (
    <>
      {report ? (
        <p className="k-report">
          {reportLine(report, props.lab.agents, props.now)}{' '}
          <a
            href={href({ page: 'thread', id: report.post.thread, post: report.post.id })}
            onClick={() => {
              // The report is on the wall. Where the panel covers the wall, the panel closes to show it.
              if (window.matchMedia(COVERS).matches) props.onTab(null);
            }}
          >
            Read the report
          </a>
        </p>
      ) : null}
      <ol className="k-talk">
        <li className="k-public">
          Every agent can read this conversation. It is a thread of the lab.
        </li>
        {posts.map((item) => (
          <Fragment key={item.post.id}>
            <Say item={item} {...props} />
            {heard?.post === item.post.id ? (
              <li className="k-heard">
                {/* A status is a polite live region, so a screen reader says the line when it changes. */}
                <span role="status">{heard.text}</span>
              </li>
            ) : null}
          </Fragment>
        ))}
      </ol>
      <Write
        placeholder={`Tell ${name} what you want`}
        hint={wakes(holder, props.lab) ? `Your message wakes ${name}.` : ''}
        onSend={async (text) => {
          const { headline, body } = split(text);
          await props.api.post({
            kind: 'message',
            text: headline,
            ...(body ? { body } : {}),
            conversation: true,
          });
          props.reload();
        }}
      />
    </>
  );
}

/** One row of the conversation: who wrote it, when, and the words. A request and an ask that waits are boxed. */
function Say(props: Shared & { readonly item: PostView }): ReactElement {
  const { item } = props;
  const { post, at } = item;
  const mine = post.author === PERSON;
  // Any agent can post in this thread. Only the coordinator's posts are the coordinator's side of the talk.
  const other = !mine && post.author !== props.view.coordinator;
  const waits = props.view.waits.includes(post.id);
  const boxed = post.kind === 'request' || (post.kind === 'ask' && waits);
  return (
    <li
      id={`k-${post.id}`}
      className={`k-say${mine ? ' you' : ''}${boxed ? ' ask' : ''}${other ? ' other' : ''}`}
    >
      <p className="k-who">
        <b>{mine ? 'You' : authorName(props.lab.agents, post.author)}</b>
        {other ? <span className="f-tag">not the coordinator</span> : null}
        <time dateTime={at}>{clock(at)}</time>
      </p>
      {post.kind === 'request' ? (
        <RequestBox {...props} />
      ) : (
        <>
          <div className="k-words">
            <p className="k-text">{post.text}</p>
            {post.body ? <Words text={post.body} /> : null}
          </div>
          {post.kind === 'ask' && waits ? (
            <Answer
              choices={post.choices}
              onAnswer={async (choice, words) => {
                const answer = personAnswer(post, choice, words);
                if (answer) await props.api.post(answer);
                props.reload();
              }}
            />
          ) : null}
        </>
      )}
    </li>
  );
}

/**
 * What the panel shows when the server refused something: the app's own sentence, and under it the server's
 * words in a box of their own. The server's words can hold text of an agent, such as the key of a harness that an
 * agent named, so they never stand inside a sentence of the app.
 */
export function Refused(props: { readonly text: string }): ReactElement {
  return (
    <div className="k-refused" role="alert">
      <p className="error">Verifold did not do this.</p>
      <Exact label="What the server said" text={props.text} />
    </div>
  );
}

/** The fields of a move as labelled values. A value that an agent or a harness wrote stands in a box of its own. */
function Fields(props: { readonly details: readonly Detail[] }): ReactElement {
  return (
    <dl className="k-fields">
      {props.details.map((detail) => (
        <div key={detail.label}>
          <dt>{detail.label}</dt>
          <dd className={detail.theirs ? 'theirs' : undefined}>{detail.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A request of the coordinator for a move: what it asks for, every field of the move, the coordinator's reason,
 * and the answers.
 *
 * The app writes the heading and the labels. Each value that an agent or a harness wrote stands in a box of its
 * own under its label, and so does the coordinator's reason, so none of it reads as the app's sentence or as the
 * person's. A command shows only in the boxes of the permission request that the move names.
 */
export function RequestBox(props: Shared & { readonly item: PostView }): ReactElement | null {
  const { item, view } = props;
  const { post } = item;
  if (post.kind !== 'request') return null;
  const { move } = post;
  const asked =
    move.type === 'permission' ? view.asks.find((ask) => ask.post.id === move.ask) : null;
  const shown = asked?.post.kind === 'ask' ? (asked.post.shown ?? null) : null;
  const state = requestState(item);
  const deed = deedOf(view, post.id);
  return (
    <>
      <p className="k-ask-head">{askLine(move)}</p>
      <Fields details={details(move, props, deed?.agent ?? null)} />
      <p className="k-label">The coordinator’s reason</p>
      <div className="k-reason">
        <p className="k-text">{post.text}</p>
        {post.body ? <Words text={post.body} /> : null}
      </div>
      {asked && shown ? (
        <>
          {/* The agent's name stands under its label above. The sentences of these boxes name no agent. */}
          <HarnessAsk shown={shown} name="that agent" />
          <p className="k-note">
            <a href={href({ page: 'thread', id: asked.post.thread, post: asked.post.id })}>
              See the request in its thread
            </a>
            . To pick another answer, answer it on the Needs you page.
          </p>
        </>
      ) : null}
      {state === 'waits' ? (
        <Decide {...props} item={item} />
      ) : state === 'ended' ? (
        <p className="k-did">{endedLine(item)}</p>
      ) : state === 'no' ? (
        <p className="k-did">You said: not now.</p>
      ) : (
        <>
          <p className="k-did">
            <span className="f-mark fm-good" aria-hidden="true" /> {doneLine(item)}.{' '}
            {decidedLine(item)}
          </p>
          {deed ? <Undo {...props} deed={deed} /> : null}
        </>
      )}
    </>
  );
}

/** The answers to a request that waits: yes, for more time another amount, and not now. */
function Decide(props: Shared & { readonly item: PostView }): ReactElement | null {
  const { post } = props.item;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [other, setOther] = useState<string | null>(null);
  const amountId = useId();
  if (post.kind !== 'request') return null;
  const { move } = post;
  const answer = (yes: boolean, minutes?: number): void => {
    setBusy(true);
    setError(null);
    props.api.answerRequest(post.id, yes, minutes).then(
      () => {
        props.reload();
      },
      (failure: unknown) => {
        setError(messageOf(failure));
        setBusy(false);
      },
    );
  };
  const minutes = other === null ? null : minutesOf(other);
  return (
    <>
      <p className="k-buttons">
        <button
          type="button"
          className="go"
          disabled={busy}
          onClick={() => {
            answer(true);
          }}
        >
          {yesLabel(move)}
        </button>
        {move.type === 'time' && other === null ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setOther(String(move.minutes));
            }}
          >
            Give another amount
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            answer(false);
          }}
        >
          Not now
        </button>
      </p>
      {other === null ? null : (
        <p className="k-amount">
          <label htmlFor={amountId}>Minutes</label>
          <input
            id={amountId}
            type="number"
            min={1}
            value={other}
            onChange={(event) => {
              setOther(event.target.value);
            }}
          />
          <button
            type="button"
            disabled={busy || minutes === null}
            onClick={() => {
              if (minutes !== null) answer(true, minutes);
            }}
          >
            Give {minutes ?? '…'} min
          </button>
        </p>
      )}
      {error ? <Refused text={error} /> : null}
    </>
  );
}

/** The way back from a move, when the person has one: the removal of an added agent, or of the minutes. */
function Undo(props: Shared & { readonly deed: Deed }): ReactElement | null {
  const { deed } = props;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = undoLabel(deed);
  if (label === null) return null;
  const agent = deed.undo === 'remove_agent' ? deed.agent : null;
  const undo = (): void => {
    setBusy(true);
    setError(null);
    const done = agent
      ? props.api.removeAgent(agent)
      : props.api.takeMinutesBack(deed.request.post.id);
    done.then(
      () => {
        props.reload();
      },
      (failure: unknown) => {
        setError(messageOf(failure));
        setBusy(false);
      },
    );
  };
  return (
    <>
      <p className="k-buttons">
        {agent && confirming ? (
          <>
            <span>Remove this agent for good? Its posts stay on the board.</span>
            <button type="button" disabled={busy} onClick={undo}>
              Remove
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (agent) setConfirming(true);
              else undo();
            }}
          >
            {label}
          </button>
        )}
      </p>
      {error ? <Refused text={error} /> : null}
    </>
  );
}

/** The answer to an ask of the coordinator: a press on a choice, or the person's own words. */
function Answer(props: {
  readonly choices: readonly string[];
  readonly onAnswer: (choice: string | null, words: string) => Promise<void>;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (choice: string | null, words: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await props.onAnswer(choice, words);
    } catch (failure) {
      setError(messageOf(failure));
      throw failure;
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {props.choices.length > 0 ? (
        <p className="k-buttons">
          {props.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              disabled={busy}
              onClick={() => {
                send(choice, '').catch(() => undefined);
              }}
            >
              {choice}
            </button>
          ))}
        </p>
      ) : null}
      <Write
        placeholder={props.choices.length > 0 ? 'Or answer in your own words' : 'Your answer'}
        hint=""
        button="Answer"
        onSend={(text) => send(null, text)}
      />
      {error ? <Refused text={error} /> : null}
    </>
  );
}

/** A box where the person writes: the first line is the headline, and the rest is the detail. */
function Write(props: {
  readonly placeholder: string;
  readonly hint: string;
  readonly button?: string;
  readonly onSend: (text: string) => Promise<void>;
}): ReactElement {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    props.onSend(text).then(
      () => {
        setText('');
        setSending(false);
      },
      (failure: unknown) => {
        setError(messageOf(failure));
        setSending(false);
      },
    );
  };
  return (
    <form className="k-write" onSubmit={send}>
      <textarea
        rows={2}
        aria-label={props.placeholder}
        placeholder={props.placeholder}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send(event);
        }}
      />
      <div>
        <span>{props.hint}</span>
        <button type="submit" disabled={!text.trim() || sending}>
          {sending ? 'Sending' : (props.button ?? 'Send')}
        </button>
      </div>
      {error ? <Refused text={error} /> : null}
    </form>
  );
}

/** What the coordinator may do without asking: one switch for each kind of move, each off until the person switches it on. */
function Powers(props: Shared & { readonly name: string }): ReactElement {
  const { name } = props;
  const [busy, setBusy] = useState<Power | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = (power: Power, on: boolean): void => {
    setBusy(power);
    setError(null);
    props.api
      .setPower(power, on)
      .then(
        () => {
          props.reload();
        },
        (failure: unknown) => {
          setError(messageOf(failure));
        },
      )
      .finally(() => {
        setBusy(null);
      });
  };
  return (
    <div className="k-powers">
      <p className="k-lede">
        {name} asks you before each of these. Switch one on, and {name} does it without asking while
        the lab has time. After the lab’s time ran out, or after you stopped the lab, {name} asks
        you again. Each use shows under “Done for you”.
      </p>
      <ul>
        {props.view.powers.map((power) => {
          const words = POWER_WORDS[power.power];
          const line = powerLine(power);
          return (
            <li key={power.power} className={power.on ? 'on' : undefined}>
              <div>
                <b>{words.name}</b>
                <p>{words.what(name)}</p>
                {line ? <p className="k-since">{line}</p> : null}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={power.on}
                aria-label={words.name}
                className="k-switch"
                disabled={busy === power.power}
                onClick={() => {
                  change(power.power, !power.on);
                }}
              >
                <i aria-hidden="true" />
                <span>{power.on ? 'On' : 'Off'}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {error ? <Refused text={error} /> : null}
      <p className="k-foot">Stopping the lab stays with you. No switch gives it away.</p>
    </div>
  );
}

/** What was done for the person: each move that came from a request, newest first, with the way back when there is one. */
function Log(props: Shared): ReactElement {
  const { deeds } = props.view;
  if (deeds.length === 0) {
    return <p className="k-log k-none">Nothing was done for you yet.</p>;
  }
  return (
    <ol className="k-log">
      {deeds.map((deed) => {
        const at = deed.request.decision?.at ?? deed.request.at;
        return (
          <li key={deed.request.post.id}>
            <time dateTime={at}>{clock(at)}</time>
            <div>
              <p>{doneLine(deed.request)}</p>
              <span className="k-by">{decidedLine(deed.request)}</span>
              {deed.request.post.kind === 'request' ? (
                <Fields details={details(deed.request.post.move, props, deed.agent)} />
              ) : null}
              <Undo {...props} deed={deed} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The line on a thread's card that says that the coordinator opened the thread for the person. */
export function OpenedForYou(props: {
  readonly summary: ThreadSummary;
  readonly agents: readonly AgentView[];
}): ReactElement | null {
  const { thread } = props.summary;
  if (!thread.for_person) return null;
  return (
    <span className="k-for">Opened for you by {authorName(props.agents, thread.opened_by)}</span>
  );
}

/**
 * The mark on a post that the coordinator posted on the person's behalf. The words of the post are the
 * coordinator's, so the mark names who posted it.
 */
export function ForYou(props: {
  readonly marked: boolean | undefined;
  readonly agents: readonly AgentView[];
  readonly author: string;
}): ReactElement | null {
  if (!props.marked) return null;
  return <span className="k-for">posted for you by {authorName(props.agents, props.author)}</span>;
}

/** A request of the coordinator on the Needs you page, with its answers. */
export function RequestNeed(props: PageProps & { readonly item: PostView }): ReactElement {
  const { api, data, item } = props;
  const view = data.conversation ?? NO_VIEW;
  const name = authorName(data.lab.agents, item.post.author);
  return (
    <section className="nitem open k-need" aria-label={`${name}: ${item.post.text}`}>
      <div className="nh">
        <Who agents={data.lab.agents} id={item.post.author} />
        <b>{name}</b>
        <span className="kind">Asks you for a move</span>
      </div>
      <div className="nbody">
        <RequestBox
          api={api}
          view={view}
          lab={data.lab}
          harnesses={data.setup?.harnesses ?? []}
          asks={view.asks}
          now={props.now}
          reload={data.reload}
          item={item}
        />
      </div>
    </section>
  );
}
