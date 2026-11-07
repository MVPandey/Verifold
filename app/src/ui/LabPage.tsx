import { useState } from 'react';
import type { ReactElement } from 'react';

import type { AgentView, HarnessOption, LabView, PostView, ThreadSummary } from '../api/types.ts';
import {
  authorName,
  costLine,
  harnessTitle,
  labTotal,
  mark,
  stateLine,
  tone,
} from '../model/agents.ts';
import { clock } from '../model/format.ts';
import { orderNeeds } from '../model/needs.ts';
import { isPermission, personMessage } from '../model/posts.ts';
import type { Chip } from '../model/posts.ts';
import { href } from '../model/route.ts';
import { hasNew, readSeen } from '../model/seen.ts';
import type { Seen } from '../model/seen.ts';
import { endLine, moreTime } from '../model/time.ts';
import { messageOf } from './hooks.ts';
import type { PageProps } from './hooks.ts';
import { Avatar, ChipView, Composer } from './parts.tsx';

/** The lab at a glance: what waits for the person, the threads, the agents, and the lab's time. */
export function LabPage({ api, data, now }: PageProps): ReactElement {
  const { lab, threads, needs } = data;
  const harnesses = data.setup?.harnesses ?? [];
  const seen = readSeen(window.localStorage, lab.opened_at);

  const send = async (text: string): Promise<void> => {
    const request = personMessage(text);
    if (request) await api.post(request);
    data.reload();
  };

  return (
    <div className="cols lab">
      <div className="maincol">
        <h1 className="labq">{lab.question}</h1>
        <p className="statusline">
          {lab.posts} {lab.posts === 1 ? 'post' : 'posts'} · {lab.threads}{' '}
          {lab.threads === 1 ? 'thread' : 'threads'} · Spent {labTotal(lab.agents)}
        </p>
        <NeedsBanner needs={needs} agents={lab.agents} />
        <section className="section">
          <div className="sechead">
            <h2>
              Threads <span className="n">{threads.length}</span>
            </h2>
          </div>
          {threads.length > 0 ? (
            <div className="rows">
              {threads.map((summary) => (
                <ThreadRow
                  key={summary.thread.id}
                  summary={summary}
                  agents={lab.agents}
                  seen={seen}
                />
              ))}
            </div>
          ) : (
            <p className="empty">No threads yet. The first agent opens a plan thread.</p>
          )}
        </section>
      </div>
      <aside className="agents">
        <h2>
          Agents <span className="n">{lab.agents.length}</span>
        </h2>
        <div className="rows">
          {lab.agents.map((view) => (
            <AgentRow
              key={view.agent.id}
              view={view}
              agents={lab.agents}
              harnesses={harnesses}
              now={now}
            />
          ))}
        </div>
        <div className="total">
          <span>Lab total</span>
          <b>{labTotal(lab.agents)}</b>
        </div>
        <TimePanel lab={lab} now={now} api={api} onChange={data.reload} />
      </aside>
      <Composer
        to="All agents"
        placeholder="Tell the agents what to change or check"
        hint="Your message opens a new thread, and every agent gets it."
        onSend={send}
      />
    </div>
  );
}

function NeedsBanner(props: {
  readonly needs: readonly PostView[];
  readonly agents: readonly AgentView[];
}): ReactElement | null {
  const first = orderNeeds(props.needs, props.agents)[0];
  if (first === undefined) return null;
  const name = authorName(props.agents, first.post.author);
  const ask = isPermission(first.post)
    ? `${name} asks for permission: ${first.post.text.replace(/^Permission needed:\s*/, '')}`
    : `${name} asks you: ${first.post.text}`;
  const more = props.needs.length - 1;
  return (
    <div className="needs">
      <div className="txt">
        <div className="lbl">{props.needs.length} WAIT FOR YOU</div>
        <p>{ask}</p>
        {more > 0 ? (
          <p className="also">{more === 1 ? 'One more ask waits.' : `${more} more asks wait.`}</p>
        ) : null}
      </div>
      <a className="btn need" href={href({ page: 'needs' })}>
        Answer
      </a>
    </div>
  );
}

function ThreadRow(props: {
  readonly summary: ThreadSummary;
  readonly agents: readonly AgentView[];
  readonly seen: Seen;
}): ReactElement {
  const { summary } = props;
  const latest = summary.latest;
  const fresh = hasNew(summary, props.seen);
  return (
    <a className="trow" href={href({ page: 'thread', id: summary.thread.id })}>
      {fresh ? <span className="newdot" title="New posts" /> : <span />}
      <span className="tt">
        {summary.thread.title}
        {fresh ? <span className="sr"> (new posts)</span> : null}
      </span>
      <span className="last">
        {latest ? (
          <>
            <b>{authorName(props.agents, latest.author)}:</b>
            <span className="q">{latest.text}</span>
          </>
        ) : null}
      </span>
      <span className="meta">
        <span className="counts-chips">
          {threadChips(summary).map((chip) => (
            <ChipView key={chip.label} chip={chip} />
          ))}
        </span>
        <time dateTime={summary.last_at}>{clock(summary.last_at)}</time>
      </span>
    </a>
  );
}

function threadChips(summary: ThreadSummary): readonly Chip[] {
  const chips: readonly (Chip | null)[] = [
    summary.disputed ? { label: `${summary.disputed} disputed`, tone: 'dis' } : null,
    summary.checked ? { label: `${summary.checked} checked`, tone: 'ok' } : null,
    summary.not_checked ? { label: `${summary.not_checked} not checked`, tone: 'none' } : null,
    summary.open_asks
      ? {
          label: summary.open_asks === 1 ? 'Open ask' : `${summary.open_asks} open asks`,
          tone: 'ask',
        }
      : null,
  ];
  return chips.filter((chip): chip is Chip => chip !== null);
}

function AgentRow(props: {
  readonly view: AgentView;
  readonly agents: readonly AgentView[];
  readonly harnesses: readonly HarnessOption[];
  readonly now: Date;
}): ReactElement {
  const { agent, activity } = props.view;
  const state = stateLine(activity, props.now);
  return (
    <div className="arow">
      <Avatar mark={mark(agent.id)} tone={tone(props.harnesses, props.agents, agent.id)} />
      <div className="nm">
        {agent.name} <span className="hb">{harnessTitle(props.harnesses, agent.harness)}</span>
      </div>
      <div className="st">
        <span className={`dot ${state.dot}${state.dot === 'live' ? ' pulse' : ''}`} />
        <span>{state.text}</span>
      </div>
      <div className="cost">{costLine(props.view)}</div>
    </div>
  );
}

function TimePanel(props: {
  readonly lab: LabView;
  readonly now: Date;
  readonly api: PageProps['api'];
  readonly onChange: () => void;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { lab } = props;

  const setTime = (minutes: number): void => {
    setError(null);
    props.api.setTime(minutes).then(
      () => {
        setConfirming(false);
        props.onChange();
      },
      (failure: unknown) => {
        setError(messageOf(failure));
      },
    );
  };

  return (
    <div className="timebox">
      <p>{endLine(lab, props.now)}</p>
      <div className="timeacts">
        {lab.ends_at !== null ? (
          <>
            <button
              className="btn small"
              type="button"
              onClick={() => setTime(moreTime(lab, 30, props.now))}
            >
              30 more min
            </button>
            <button
              className="btn small"
              type="button"
              onClick={() => setTime(moreTime(lab, 60, props.now))}
            >
              1 more hour
            </button>
          </>
        ) : null}
        {lab.out_of_time ? null : confirming ? (
          <button className="btn small danger" type="button" onClick={() => setTime(0)}>
            Stop every agent now
          </button>
        ) : (
          <button className="linkbtn" type="button" onClick={() => setConfirming(true)}>
            Stop the lab
          </button>
        )}
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
