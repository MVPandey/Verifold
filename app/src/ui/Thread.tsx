import { useState } from 'react';
import type { ReactElement } from 'react';

import type { AgentView, PostView, RerunLine, ThreadView } from '../api/types.ts';
import { PERSON } from '../api/types.ts';
import { author, authorName, called } from '../model/agents.ts';
import { clock } from '../model/format.ts';
import { builtOnLabel, isLong, standingChip } from '../model/posts.ts';
import { href } from '../model/route.ts';
import { offersReplyHint } from '../model/deliverables.ts';
import { sideReplyHint } from '../model/side.ts';
import { MAX_RERUNS, wantedLine } from '../model/status.ts';
import { holdsNew, markUnfolded, readUnfolded } from '../model/seen.ts';
import {
  act,
  foldLabel,
  foldedCount,
  isClaim,
  repliesLabel,
  replyFolds,
  replyRoot,
  rerunChecks,
  rows,
  standingIn,
  unfoldLabel,
} from '../model/turns.ts';
import type { Depth } from '../model/turns.ts';
import { hasBreakthrough } from '../model/votes.ts';
import { messageOf } from '../api/client.ts';
import { ForYou } from './Coordinator.tsx';
import { byDesk } from '../model/desk.ts';
import { browserStore } from './hooks.ts';
import { Detail } from './Markdown.tsx';
import { ChipView, Composer, HarnessAsk, Mark, New } from './parts.tsx';
import { Name, Who } from './Picture.tsx';
import { Badges, Votes, useRing } from './Votes.tsx';
import type { MarkActions } from './Votes.tsx';

/** What every turn of a thread needs from the lab. */
interface Around {
  readonly view: ThreadView;
  readonly agents: readonly AgentView[];
  /** The asks that wait for the person. */
  readonly needs: readonly PostView[];
  /** The ID of the question's thread, or `null` when the lab has none. */
  readonly question: string | null;
  /** Whether the lab's agents say that it is done, so that a side thread's reply box says what a reply does. */
  readonly done?: boolean;
  /** Whether the lab is open, closing, or closed, for what the person's post in a thread of offers does. */
  readonly state?: 'open' | 'closing' | 'closed';
  /** The reruns that are wanted in the lab. */
  readonly reruns: readonly RerunLine[];
  /** How many reviewer seats the lab has, for what a wanted rerun says about who can take it. */
  readonly seats: number;
  readonly now: Date;
  readonly onRerun: (postId: string) => Promise<void>;
  /** The person's moves on votes and badges. Without them, a post shows its votes and takes none. */
  readonly marks?: MarkActions | undefined;
}

/**
 * An opened thread: its turns, each reply under the post that it answers, and a box to reply in it. The replies
 * under a top-level post fold behind one row, which opens them in place, and the replies that `rows` keeps in
 * sight stay outside it. A run of two or more agents' plain messages that nobody replied to is one row too, which
 * opens in place. One control above the posts shows every such message and every reply, and folds them again. A
 * side thread and the conversation with the coordinator fold nothing.
 */
export function Turns(
  props: Around & {
    readonly onSend: (text: string) => Promise<void>;
    /** The post that the page opened on. It is never inside a fold. */
    readonly target?: string | null;
    /** When the lab opened. With it, the browser keeps for each thread whether the person shows every message. */
    readonly lab?: string;
    /**
     * The last post of the thread that the person had seen when the thread opened. A closed fold of replies that
     * holds a later post has the mark of a new post. Without it, no fold has the mark.
     */
    readonly seen?: number;
  },
): ReactElement {
  const { onSend, target, lab, seen, ...around } = props;
  const { thread } = props.view;
  const [shown, setShown] = useState(
    () => lab !== undefined && readUnfolded(browserStore, lab, thread.id),
  );
  // The page records the thread as seen when it opens, so the turns keep what the person had seen before.
  const [since] = useState(seen ?? Number.POSITIVE_INFINITY);
  // The messages of the folds that the person opened. A run changes when one of its messages gets a reply or a
  // badge, or when a message joins it. The row of any run that holds one of these stays open then.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  // The person's choice for the replies of each top-level post, by its ID, so it holds when replies come in.
  // Without a choice, only the replies around the post that the page opened on show.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const home = replyRoot(props.view.posts, target ?? null);
  const folding = !thread.conversation && props.view.members.length === 0;
  const list = rows(
    props.view.posts,
    target ?? null,
    folding,
    (root) => shown || (chosen.get(root) ?? root === home),
  );
  const every = rows(props.view.posts, target ?? null, folding, () => true);
  const [folded, trees] = [foldedCount(every), replyFolds(every)];
  const turn = (item: PostView, depth: Depth): ReactElement => (
    <Turn key={item.post.id} item={item} depth={depth} {...around} />
  );
  const toggle = (items: readonly PostView[], open: boolean): void => {
    setOpened((before) => {
      const after = new Set(before);
      for (const item of items) {
        if (open) after.add(item.post.id);
        else after.delete(item.post.id);
      }
      // The browser also reports a row that the page opened itself. Then nothing changes.
      return after.size === before.size ? before : after;
    });
  };
  return (
    <>
      {folded > 0 || trees > 0 ? (
        <p className="f-unfold">
          <button
            type="button"
            className="linkbtn"
            aria-expanded={shown}
            onClick={() => {
              setShown(!shown);
              if (lab !== undefined) markUnfolded(browserStore, lab, thread.id, !shown);
            }}
          >
            {unfoldLabel(folded, trees, shown)}
          </button>
        </p>
      ) : null}
      <ol className="f-turns">
        {/*
          Each row is a direct child of the list under a key: a turn under its post's ID, and a fold under the
          ID of its first message. So a post that comes in remounts no turn of the list, also while every
          message shows. A turn inside a fold is a child of that fold: when its run splits, the turns that go
          to the new row mount again there, and the new row is open when the person had opened the old one.
        */}
        {list.flatMap((row) =>
          row.kind === 'turn'
            ? [turn(row.item, row.depth)]
            : row.kind === 'replies'
              ? shown
                ? []
                : [
                    <li key={`replies-${row.root}`} className="f-fold f-tree d1">
                      <button
                        type="button"
                        aria-expanded={row.open}
                        onClick={() => {
                          setChosen((before) => new Map(before).set(row.root, !row.open));
                        }}
                      >
                        {repliesLabel(row.items)}
                      </button>
                      {!row.open && holdsNew(row.items, since) ? <New /> : null}
                    </li>,
                  ]
              : shown
                ? row.items.map((item) => turn(item, row.depth))
                : [
                    <li key={row.items[0]?.post.id} className={`f-fold d${row.depth}`}>
                      <details
                        open={row.items.some((item) => opened.has(item.post.id))}
                        onToggle={(event) => {
                          toggle(row.items, event.currentTarget.open);
                        }}
                      >
                        <summary>{foldLabel(row.items, (id) => called(props.agents, id))}</summary>
                        <ol className="f-turns">{row.items.map((item) => turn(item, 0))}</ol>
                      </details>
                    </li>,
                  ],
        )}
      </ol>
      <Composer
        variant="reply"
        label="Message to everyone in this thread"
        placeholder="Say something in this thread"
        button="Post"
        hint={
          props.view.members.length > 0
            ? sideReplyHint(props.done ?? false)
            : props.view.person_reaches
              ? offersReplyHint(props.view.person_reaches, props.agents, props.state ?? 'open')
              : 'Agents that watch this thread get your reply. When nobody watches it, every agent does.'
        }
        onSend={onSend}
      />
    </>
  );
}

/**
 * One turn: who wrote it, what it does in one line, the words, and the detail on request. The first line has the
 * author's name, its seat as it was when it wrote the post, and what it is to the thread. Roles are in the member
 * list and the profile.
 */
export function Turn(
  props: Around & { readonly item: PostView; readonly depth: Depth },
): ReactElement {
  const { agents, view } = props;
  const { post, standing, at } = props.item;
  const find = (id: string | null): PostView | undefined =>
    view.posts.find((item) => item.post.id === id);
  const agent = agents.find((entry) => entry.agent.id === post.author)?.agent ?? null;
  const to = find(post.reply_to)?.post ?? null;
  const toFamily = agents.find((entry) => entry.agent.id === to?.author)?.agent.model.family;
  const tag = standingIn(agent, view.thread, props.question, toFamily ?? null);
  const who = author(agents, post.author);
  const { by } = props.item;
  const chip = standingChip(post, standing);
  const claim = isClaim(post);
  const breakthrough = hasBreakthrough(props.item);
  const ring = useRing(post.id, breakthrough);
  const wanted = props.reruns.filter((line) => line.post === post.id);
  const waits = wantedLine(wanted, { agents, reviewer_seats: props.seats }, props.now);
  // The person can always ask, once: a request of theirs that is still open shows in the line above the button.
  // A post that has the checks of all the reruns that one post gets takes no other request.
  const canRerun =
    post.kind === 'result' &&
    post.evidence.length > 0 &&
    standing !== 'held_up' &&
    post.author !== PERSON &&
    !wanted.some((line) => line.asked_by.includes(PERSON)) &&
    rerunChecks(view.posts, agents, post.id) < MAX_RERUNS;
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
    <li
      id={post.id}
      className={`f-turn${claim ? ' claim' : ''}${breakthrough ? ' v-break' : ''}${ring ? ' v-ring' : ''} d${props.depth}`}
    >
      <Who agents={agents} id={post.author} size={36} dot={false} />
      <div>
        <p className="f-turn-line">
          {who.kind === 'member' ? (
            // A post keeps the seat that wrote it. A post from before bylines shows the seat of now.
            <Name view={who.view} seat={by ? by.seat : undefined} />
          ) : (
            <b className={`f-who ${who.kind}`}>{who.name}</b>
          )}
          {post.helper ? <span className="f-tag">helper {post.helper}</span> : null}
          {tag ? <span className="f-tag">{tag}</span> : null}
          <ForYou
            marked={post.for_person}
            agents={agents}
            author={post.author}
            desk={byDesk(post)}
          />
          {/* The coordinator's post for the whole lab woke every agent that is not on call. */}
          {post.to_lab && post.author !== PERSON ? (
            <span className="f-tag">to the whole lab</span>
          ) : null}
          <time dateTime={at}>{clock(at)}</time>
        </p>
        <p className="f-act">
          <Mark post={post} />{' '}
          {act(post, to, {
            called: (id) => called(agents, id),
            author: agent,
          })}{' '}
          {chip ? <ChipView chip={chip} /> : null}
          <Badges item={props.item} />
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
        <p className={isLong(post.text) ? 'f-say-text long' : 'f-say-text'}>{post.text}</p>
        {post.kind === 'ask' && post.choices.length > 0 ? (
          <p className="choices">Choices: {post.choices.join(' · ')}</p>
        ) : null}
        {props.needs.some((need) => need.post.id === post.id) ? (
          <p className="note">
            <a href={href({ page: 'needs' })}>Answer it on the Needs you page</a>. An agent waits
            for your answer there, not for a reply in the thread.
          </p>
        ) : null}
        {post.kind === 'ask' && post.shown ? (
          // A request of a harness shows from its recorded data. It never goes through Markdown.
          <details className="f-detail">
            <summary className="f-open">
              <span className="closed">Read the detail</span>
              <span className="opened">Hide the detail</span>
            </summary>
            <div className="f-words">
              <HarnessAsk shown={post.shown} name={agent?.name ?? post.author} />
            </div>
          </details>
        ) : (
          <Detail post={post.id} body={post.body} files={post.evidence} />
        )}
        {waits ? <p className="note o-wanted">{waits}</p> : null}
        {canRerun ? <RerunButton postId={post.id} onRerun={props.onRerun} /> : null}
        <Votes item={props.item} agents={agents} actions={props.marks} />
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
        You asked for an independent rerun. An agent of the lab that can check this post can take
        it.
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
        Ask for an independent rerun
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
