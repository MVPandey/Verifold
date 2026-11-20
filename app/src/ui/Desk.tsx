import { Fragment } from 'react';
import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import { PERSON } from '../api/types.ts';
import type { AgentView, DeskView, LabView, PostView } from '../api/types.ts';
import { authorName, memberLine } from '../model/agents.ts';
import { wakes } from '../model/coordinator.ts';
import { NO_DESK, actionLine, actionsOn, deskOf } from '../model/desk.ts';
import { clock } from '../model/format.ts';
import { split } from '../model/posts.ts';
import { href } from '../model/route.ts';
import { AllowanceCard } from './Allowances.tsx';
import { Write } from './Coordinator.tsx';
import type { PageProps } from './hooks.ts';
import { Words } from './Markdown.tsx';
import { Name, Who } from './Picture.tsx';

/**
 * The desk's place in the seat of the lab page, above the coordinator's: who holds the desk seat, and the button
 * that opens the desk chat beside the wall. A lab without a desk shows nothing here.
 */
export function DeskSeat(
  props: PageProps & {
    /** Whether the desk chat is the panel that is docked. The page has one docked panel at a time. */
    readonly open: boolean;
    readonly onOpen: (open: boolean) => void;
  },
): ReactElement | null {
  const { api, data, open } = props;
  const holder = deskOf(data.lab.agents);
  if (holder === null) return null;
  return (
    <div className="k-door">
      <p className="k-door-head">
        <Who agents={data.lab.agents} id={holder.agent.id} size={34} />
        <Name view={holder} />
        <span className="i-seat coord">Desk</span>
      </p>
      <button
        type="button"
        className="k-open"
        aria-expanded={open}
        onClick={() => {
          props.onOpen(!open);
        }}
      >
        {open ? 'Close the desk chat' : `Talk to ${holder.agent.name}`}
      </button>
      {open ? (
        <DeskPanel
          api={api}
          view={data.desk ?? NO_DESK}
          holder={holder}
          lab={data.lab}
          now={props.now}
          onClose={() => {
            props.onOpen(false);
          }}
          reload={data.reload}
        />
      ) : null}
    </div>
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
  readonly onClose: () => void;
  readonly reload: () => void;
}): ReactElement {
  const { view, holder, lab } = props;
  const name = holder.agent.name;
  const resting = lab.out_of_time || lab.state === 'closed';
  const chat = view.thread?.thread.id ?? null;
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
      {chat ? (
        <Write
          placeholder={`Ask ${name}, or tell it what to do`}
          hint={wakes(holder, lab) ? `Your message wakes ${name} at once.` : ''}
          onSend={async (text) => {
            const { headline, body } = split(text);
            await props.api.post({
              kind: 'message',
              text: headline,
              ...(body ? { body } : {}),
              thread: chat,
            });
            props.reload();
          }}
        />
      ) : null}
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
      <div className="k-words">
        <p className="k-text">{post.text}</p>
        {post.body ? <Words text={post.body} /> : null}
      </div>
    </li>
  );
}
