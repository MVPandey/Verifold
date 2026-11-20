import { Fragment } from 'react';
import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import { PERSON } from '../api/types.ts';
import type { AgentView, DeskView, LabView, PostView } from '../api/types.ts';
import { authorName, memberLine } from '../model/agents.ts';
import { wakes } from '../model/coordinator.ts';
import { CHAT_BOX, NO_DESK, actionLine, actionsOn, deskOf } from '../model/desk.ts';
import { shownAllowances } from '../model/allowances.ts';
import { clock } from '../model/format.ts';
import { split } from '../model/posts.ts';
import { href } from '../model/route.ts';
import { AllowanceCard } from './Allowances.tsx';
import { Write } from './Coordinator.tsx';
import type { PageProps } from './hooks.ts';
import { Words } from './Markdown.tsx';
import { Name, Who } from './Picture.tsx';

/** The thread that a message in the desk chat is about: the one that the person has open on the page. */
export interface Subject {
  readonly id: string;
  readonly title: string;
}

/**
 * The one chat of the lab when it has a desk: the newest messages between the person and the desk, the box where
 * the person writes to the lab, and the button that opens the whole chat beside the wall. On a thread's page, a
 * message names that thread as its subject, and the desk says where it passed the message on. A lab without a desk
 * shows nothing here.
 */
export function DeskSeat(
  props: PageProps & {
    /** Whether the desk chat is the panel that is docked. The page has one docked panel at a time. */
    readonly open: boolean;
    readonly onOpen: (open: boolean) => void;
    /** The thread that the person has open, which a message is about, or `null`. */
    readonly subject: Subject | null;
    /** Write without the subject, for the person who means the whole lab. */
    readonly onClearSubject: () => void;
  },
): ReactElement | null {
  const { api, data, open, subject } = props;
  const holder = deskOf(data.lab.agents);
  if (holder === null) return null;
  const view = data.desk ?? NO_DESK;
  const recent = (view.thread?.posts ?? []).slice(-RECENT);
  return (
    <section className="c-chat" aria-labelledby="chat-title">
      <h2 id="chat-title" className="kicker">
        Chat with the lab
      </h2>
      <p className="c-desk">
        <Who agents={data.lab.agents} id={holder.agent.id} size={28} />
        <Name view={holder} />
        <span className="i-seat coord">Desk</span>
      </p>
      {recent.length > 0 ? (
        <ol className="c-bubbles">
          {recent.map((item) => (
            <Fragment key={item.post.id}>
              <Bubble item={item} agents={data.lab.agents} />
              {actionsOn(view, item.post.id).map((action, index) => (
                <li key={`${item.post.id}-${String(index)}`} className="c-did">
                  {actionLine(action, data.lab.agents)}
                </li>
              ))}
            </Fragment>
          ))}
        </ol>
      ) : (
        <p className="c-none">
          Ask where the lab stands, or tell it what you want. {holder.agent.name} answers here and
          passes your word on to the lab.
        </p>
      )}
      {/* A draft of the desk shows once: here, or in the whole chat while that is open. */}
      {open
        ? null
        : shownAllowances(data.lab)
            .filter((draft) => draft.state === 'draft')
            .map((draft) => (
              <AllowanceCard
                key={draft.allowance}
                api={api}
                view={draft}
                lab={data.lab}
                now={props.now}
                reload={data.reload}
                onChange={() => {
                  // A newer draft replaces this one, so the person tells the desk what to change.
                  document.getElementById(CHAT_BOX)?.focus();
                }}
              />
            ))}
      <ChatBox
        api={api}
        view={view}
        holder={holder}
        lab={data.lab}
        subject={subject}
        onClearSubject={props.onClearSubject}
        reload={data.reload}
      />
      <button
        type="button"
        className="linkbtn c-all"
        aria-expanded={open}
        onClick={() => {
          props.onOpen(!open);
        }}
      >
        {open ? 'Close the whole chat' : 'See the whole chat'}
      </button>
      {open ? (
        <DeskPanel
          api={api}
          view={view}
          holder={holder}
          lab={data.lab}
          now={props.now}
          subject={subject}
          onClearSubject={props.onClearSubject}
          onClose={() => {
            props.onOpen(false);
          }}
          reload={data.reload}
        />
      ) : null}
    </section>
  );
}

/** How many of the newest messages of the desk chat the lab page shows beside the question. */
const RECENT = 2;

/** One message of the chat as a bubble: the person's own on the right, the desk's on the left. */
function Bubble(props: {
  readonly item: PostView;
  readonly agents: readonly AgentView[];
}): ReactElement {
  const { post } = props.item;
  const mine = post.author === PERSON;
  return (
    <li className={`c-bubble${mine ? ' me' : ''}`}>
      <p className="c-who">{mine ? 'You' : authorName(props.agents, post.author)}</p>
      <p className="c-text">{post.text}</p>
    </li>
  );
}

/**
 * The box where the person writes to the lab, in the desk chat. On a thread's page, the message names that thread
 * in `about`, and a line above the box says so, with the way to write about the whole lab instead.
 */
function ChatBox(props: {
  readonly api: Api;
  readonly view: DeskView;
  readonly holder: AgentView;
  readonly lab: LabView;
  readonly subject: Subject | null;
  readonly onClearSubject: () => void;
  readonly reload: () => void;
}): ReactElement | null {
  const { subject, holder } = props;
  const chat = props.view.thread?.thread.id ?? null;
  if (chat === null) return null;
  return (
    <>
      {subject ? (
        <p className="c-about">
          <span>About this thread:</span> <b className="c-title">{subject.title}</b>{' '}
          <button type="button" className="linkbtn" onClick={props.onClearSubject}>
            Write about the whole lab
          </button>
        </p>
      ) : null}
      <Write
        id={CHAT_BOX}
        placeholder="Say something to the lab"
        hint={wakes(holder, props.lab) ? `Your message wakes ${holder.agent.name} at once.` : ''}
        onSend={async (text) => {
          const { headline, body } = split(text);
          await props.api.post({
            kind: 'message',
            text: headline,
            ...(body ? { body } : {}),
            thread: chat,
            ...(subject ? { about: subject.id } : {}),
          });
          props.reload();
        }}
      />
    </>
  );
}

/**
 * The panel for the desk: the desk chat as rows, each action of the desk in one line under the message of the
 * person that it rests on, and the box where the person writes to the desk. It has the layout of the panel for the
 * coordinator.
 */
export function DeskPanel(props: {
  readonly api: Api;
  readonly view: DeskView;
  readonly holder: AgentView;
  readonly lab: LabView;
  readonly now: Date;
  readonly subject?: Subject | null;
  readonly onClearSubject?: () => void;
  readonly onClose: () => void;
  readonly reload: () => void;
}): ReactElement {
  const { view, holder, lab } = props;
  const name = holder.agent.name;
  const resting = lab.out_of_time || lab.state === 'closed';
  return (
    <aside className="k-panel" aria-label={`${name}, the desk`}>
      <header>
        <Who agents={lab.agents} id={holder.agent.id} size={38} />
        <div>
          <p className="k-title">
            <Name view={holder} />
            <span className="i-seat coord">Desk</span>
          </p>
          <p className="k-prov">{memberLine(holder, resting, props.now).text}</p>
        </div>
        <button type="button" className="linkbtn" onClick={props.onClose}>
          Close
        </button>
      </header>
      <ol className="k-talk">
        <li className="k-public">
          Only you and the desk post here, and no other agent hears it. Every agent can read it. The
          desk acts only on your messages here.
        </li>
        {(view.thread?.posts ?? []).map((item) => (
          <Fragment key={item.post.id}>
            <DeskSay item={item} agents={lab.agents} />
            {actionsOn(view, item.post.id).map((action, index) => {
              const drafted = (lab.allowances ?? []).find(
                (allowance) => allowance.allowance === action.allowance,
              );
              return (
                <Fragment key={`${item.post.id}-${String(index)}`}>
                  <li className="k-heard">
                    <span>
                      {actionLine(action, lab.agents)}
                      {action.post && action.thread ? (
                        <>
                          {' · '}
                          <a href={href({ page: 'thread', id: action.thread, post: action.post })}>
                            See it
                          </a>
                        </>
                      ) : null}
                    </span>
                  </li>
                  {drafted ? (
                    <li className="k-card">
                      <AllowanceCard
                        api={props.api}
                        view={drafted}
                        lab={lab}
                        now={props.now}
                        reload={props.reload}
                        onChange={() => {
                          // A newer draft replaces this one, so the person tells the desk what to change.
                          document
                            .querySelector<HTMLTextAreaElement>('.k-panel .k-write textarea')
                            ?.focus();
                        }}
                      />
                    </li>
                  ) : null}
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </ol>
      <ChatBox
        api={props.api}
        view={view}
        holder={holder}
        lab={lab}
        subject={props.subject ?? null}
        onClearSubject={props.onClearSubject ?? (() => undefined)}
        reload={props.reload}
      />
    </aside>
  );
}

/** One row of the desk chat: who wrote it, when, and the words. */
function DeskSay(props: {
  readonly item: PostView;
  readonly agents: readonly AgentView[];
}): ReactElement {
  const { post, at } = props.item;
  const mine = post.author === PERSON;
  return (
    <li id={`k-${post.id}`} className={`k-say${mine ? ' you' : ''}`}>
      <p className="k-who">
        <b>{mine ? 'You' : authorName(props.agents, post.author)}</b>
        <time dateTime={at}>{clock(at)}</time>
      </p>
      {post.about ? (
        <p className="k-about">
          About{' '}
          <a href={href({ page: 'thread', id: post.about, post: null })}>thread {post.about}</a>
        </p>
      ) : null}
      <div className="k-words">
        <p className="k-text">{post.text}</p>
        {post.body ? <Words text={post.body} /> : null}
      </div>
    </li>
  );
}
