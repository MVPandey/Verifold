import { useState } from 'react';
import type { ReactElement } from 'react';

import type { AgentView, HarnessOption, PostView, ThreadView } from '../api/types.ts';
import { PERSON } from '../api/types.ts';
import { authorName, called, face, harnessTitle } from '../model/agents.ts';
import { clock } from '../model/format.ts';
import { builtOnLabel, standingChip } from '../model/posts.ts';
import { href } from '../model/route.ts';
import { act, isClaim, rows, standingIn } from '../model/turns.ts';
import { messageOf } from '../api/client.ts';
import { Body, ChipView, Composer, FaceView, Files, Mark } from './parts.tsx';

/** What every turn of a thread needs from the lab. */
interface Around {
  readonly view: ThreadView;
  readonly agents: readonly AgentView[];
  readonly harnesses: readonly HarnessOption[];
  /** The asks that wait for the person. */
  readonly needs: readonly PostView[];
  /** The ID of the question's thread, or `null` when the lab has none. */
  readonly question: string | null;
  readonly onRerun: (postId: string) => Promise<void>;
}

/** An opened thread: its turns, each reply under the post that it answers, and a box to reply in it. */
export function Turns(
  props: Around & { readonly onSend: (text: string) => Promise<void> },
): ReactElement {
  const { onSend, ...around } = props;
  return (
    <>
      <ol className="f-turns">
        {rows(props.view.posts, props.question).map((row) =>
          row.kind === 'turn' ? (
            <Turn key={row.item.post.id} item={row.item} depth={row.depth} {...around} />
          ) : (
            <li key={row.items[0]?.post.id} className="f-fold">
              <details>
                <summary>
                  {row.items.length === 1 ? '1 short note' : `${row.items.length} short notes`}
                </summary>
                <ol className="f-turns">
                  {row.items.map((item) => (
                    <Turn key={item.post.id} item={item} depth={0} {...around} />
                  ))}
                </ol>
              </details>
            </li>
          ),
        )}
      </ol>
      <Composer
        variant="reply"
        label="Message to everyone in this thread"
        placeholder="Say something in this thread"
        button="Post"
        hint="Agents that watch this thread get your reply. When nobody watches it, every agent does."
        onSend={onSend}
      />
    </>
  );
}

/** One turn: who wrote it, what it does in one line, the words, and the detail on request. */
export function Turn(
  props: Around & { readonly item: PostView; readonly depth: 0 | 1 | 2 },
): ReactElement {
  const { agents, view } = props;
  const { post, standing, at } = props.item;
  const find = (id: string | null): PostView | undefined =>
    view.posts.find((item) => item.post.id === id);
  const agent = agents.find((entry) => entry.agent.id === post.author)?.agent ?? null;
  const to = find(post.reply_to)?.post ?? null;
  const toFamily = agents.find((entry) => entry.agent.id === to?.author)?.agent.model.family;
  const tag = standingIn(agent, view.thread, props.question, toFamily ?? null);
  const who = face(agents, post.author);
  const chip = standingChip(post, standing);
  const claim = isClaim(post);
  const canRerun =
    post.kind === 'result' &&
    post.evidence.length > 0 &&
    standing !== 'held_up' &&
    post.author !== PERSON;
  // A post in this thread by another author gets a link. The page does not have the posts of other threads.
  const near = (id: string): PostView | undefined => {
    const other = find(id);
    return other && other.post.author !== post.author ? other : undefined;
  };
  const elsewhere = post.builds_on.filter((id) => !find(id));
  const onward = builtOnLabel(props.item.built_on_by.filter((id) => !near(id)));
  const port = (word: string, other: PostView): ReactElement => (
    <a
      key={word + other.post.id}
      className="f-port"
      href={href({ page: 'thread', id: view.thread.id, post: other.post.id })}
    >
      {word} <b>{authorName(agents, other.post.author)}</b>
    </a>
  );
  return (
    <li id={post.id} className={`f-turn${claim ? ' claim' : ''} d${props.depth}`}>
      <FaceView face={who} />
      <div>
        <p className="f-turn-line">
          <b className={`f-who ${who.kind === 'member' ? `m${who.color}` : who.kind}`}>
            {who.name}
          </b>
          {post.helper ? <span className="f-tag">helper {post.helper}</span> : null}
          {agent?.role ? <span className="f-role">{agent.role}</span> : null}
          {agent ? (
            <span className="f-tag">{harnessTitle(props.harnesses, agent.harness)}</span>
          ) : null}
          {tag ? <span className="f-tag">{tag}</span> : null}
          <time dateTime={at}>{clock(at)}</time>
        </p>
        <p className="f-act">
          <Mark post={post} />{' '}
          {act(post, to, {
            called: (id) => called(agents, id),
            author: agent,
            question: props.question,
          })}{' '}
          {chip ? <ChipView chip={chip} /> : null}
        </p>
        {post.builds_on
          .map((id) => near(id))
          .map((other) => other && port('After an idea from', other))}
        {elsewhere.length > 0 ? (
          <span className="f-port">Builds on {elsewhere.join(', ')} in another thread</span>
        ) : null}
        {props.item.built_on_by
          .map((id) => near(id))
          .map((other) => other && port('Built on by', other))}
        {onward ? <span className="f-port">{onward}</span> : null}
        <p className="f-say-text">{post.text}</p>
        {post.kind === 'ask' && post.choices.length > 0 ? (
          <p className="choices">Choices: {post.choices.join(' · ')}</p>
        ) : null}
        {props.needs.some((need) => need.post.id === post.id) ? (
          <p className="note">
            <a href={href({ page: 'needs' })}>Answer it on the Needs you page</a>. An agent waits
            for your answer there, not for a reply in the thread.
          </p>
        ) : null}
        {post.body || post.evidence.length > 0 ? (
          <details className="f-detail">
            <summary className="f-open">
              <span className="closed">Read the detail</span>
              <span className="opened">Hide the detail</span>
            </summary>
            <div className="f-words">
              {post.body ? <Body text={post.body} /> : null}
              <Files files={post.evidence} />
            </div>
          </details>
        ) : null}
        {canRerun ? <RerunButton postId={post.id} onRerun={props.onRerun} /> : null}
      </div>
    </li>
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
