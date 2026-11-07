import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { AgentView, HarnessOption, PostView, ThreadView } from '../api/types.ts';
import { PERSON } from '../api/types.ts';
import { authorName, harnessTitle, mark, tone } from '../model/agents.ts';
import { clock } from '../model/format.ts';
import { kindLabel, personMessage, standingChip } from '../model/posts.ts';
import { href } from '../model/route.ts';
import { markSeen } from '../model/seen.ts';
import { messageOf } from './hooks.ts';
import type { PageProps } from './hooks.ts';
import { Avatar, Body, ChipView, Composer, Files } from './parts.tsx';

/** One thread: every post in order, and a box to reply in it. */
export function ThreadPage({ api, data, id }: PageProps & { readonly id: string }): ReactElement {
  const [view, setView] = useState<ThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { lab, version } = data;

  useEffect(() => {
    let current = true;
    api.thread(id).then(
      (read) => {
        if (!current) return;
        setView(read);
        setError(null);
        const last = read.posts.at(-1);
        if (last) markSeen(window.localStorage, lab.opened_at, id, last.seq);
      },
      (failure: unknown) => {
        if (current) setError(messageOf(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [api, id, version, lab.opened_at]);

  if (view === null) {
    return <p className="lone">{error ?? 'Loading the thread.'}</p>;
  }
  const first = view.posts[0];
  const send = async (text: string): Promise<void> => {
    const request = personMessage(text, id);
    if (request) await api.post(request);
    data.reload();
  };
  return (
    <div className="narrow">
      <p className="crumbs">
        <a href={href({ page: 'lab' })}>Lab</a> / Thread
      </p>
      <h1>{view.thread.title}</h1>
      <p className="sub">
        {authorName(lab.agents, view.thread.opened_by)} opened it
        {first ? ` at ${clock(first.at)}` : ''}.
      </p>
      <div className="posts">
        {view.posts.map((item) => (
          <PostItem
            key={item.post.id}
            item={item}
            thread={view}
            agents={lab.agents}
            harnesses={data.setup?.harnesses ?? []}
            waitsForYou={data.needs.some((need) => need.post.id === item.post.id)}
            onRerun={(postId) => api.rerun(postId)}
          />
        ))}
      </div>
      <Composer
        to="Everyone in this thread"
        placeholder="Ask, object, or say what to check next"
        hint="Agents that watch this thread get your reply. When nobody watches it, every agent does."
        onSend={send}
      />
    </div>
  );
}

/** One post: who wrote it, what it does, where it stands, its files, and its detail. */
export function PostItem(props: {
  readonly item: PostView;
  readonly thread: ThreadView;
  readonly agents: readonly AgentView[];
  readonly harnesses: readonly HarnessOption[];
  readonly waitsForYou: boolean;
  readonly onRerun: (postId: string) => Promise<void>;
}): ReactElement {
  const { post, standing, at } = props.item;
  const agent = props.agents.find((view) => view.agent.id === post.author)?.agent;
  const target = props.thread.posts.find((item) => item.post.id === post.reply_to)?.post;
  const chip = standingChip(post, standing);
  const kindClass = post.kind === 'message' || post.kind === 'ruled_out' ? 'msg' : post.kind;
  const canRerun =
    post.kind === 'result' &&
    post.evidence.length > 0 &&
    standing !== 'held_up' &&
    post.author !== PERSON;
  return (
    <article className={`post${post.author === PERSON ? ' mine' : ''}`} id={post.id}>
      <Avatar mark={mark(post.author)} tone={tone(props.harnesses, props.agents, post.author)} />
      <div className="pb">
        <div className="pm">
          <b>{authorName(props.agents, post.author)}</b>
          {agent ? (
            <span className="hb">{harnessTitle(props.harnesses, agent.harness)}</span>
          ) : null}
          <span className={`kind k-${kindClass}`}>{kindLabel(post)}</span>
          {target ? (
            <span className="to">
              on {authorName(props.agents, target.author)}&rsquo;s {kindLabel(target).toLowerCase()}
            </span>
          ) : null}
          {post.kind === 'check' ? (
            <span className={post.outcome === 'holds' ? 'outcome-held' : 'outcome-not'}>
              {post.outcome === 'holds' ? 'held' : 'did not hold'}
            </span>
          ) : null}
          <time dateTime={at}>{clock(at)}</time>
          {chip ? <ChipView chip={chip} /> : null}
        </div>
        <p className="ph">{post.text}</p>
        {post.kind === 'ask' && post.choices.length > 0 ? (
          <p className="choices">Choices: {post.choices.join(' · ')}</p>
        ) : null}
        {props.waitsForYou ? (
          <p className="note">
            <a href={href({ page: 'needs' })}>Answer it on the Needs you page</a>. An agent waits
            for your answer there, not for a reply in the thread.
          </p>
        ) : null}
        <Files files={post.evidence} />
        {post.body ? (
          <details className="more">
            <summary>Details</summary>
            <Body text={post.body} />
          </details>
        ) : null}
        {canRerun ? <RerunButton postId={post.id} onRerun={props.onRerun} /> : null}
      </div>
    </article>
  );
}

function RerunButton(props: {
  readonly postId: string;
  readonly onRerun: (postId: string) => Promise<void>;
}): ReactElement {
  const [state, setState] = useState<'ready' | 'asking' | 'asked'>('ready');
  const [error, setError] = useState<string | null>(null);
  if (state === 'asked') {
    return (
      <p className="note">
        A checker from another model family gets the files, not the thread, and reruns it.
      </p>
    );
  }
  return (
    <p className="note">
      <button
        className="linkbtn"
        type="button"
        disabled={state === 'asking'}
        onClick={() => {
          setState('asking');
          props.onRerun(props.postId).then(
            () => setState('asked'),
            (failure: unknown) => {
              setError(messageOf(failure));
              setState('ready');
            },
          );
        }}
      >
        Ask for a blind rerun
      </button>
      {error ? (
        <span className="error" role="alert">
          {' '}
          {error}
        </span>
      ) : null}
    </p>
  );
}
