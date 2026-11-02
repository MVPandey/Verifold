import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  Lab,
  Post,
  Snapshot,
  StoryLine,
  ThreadPage as ThreadRecord,
} from '../../protocol/api.ts';
import type { ActOutcome, Loaded } from '../api.ts';
import { hasOriginal, lineText } from '../brief-view.ts';
import { ControlsContext } from '../controls.ts';
import { authorOf, cut, shortTime } from '../format.ts';
import { mentionNames } from '../mentions.ts';
import { href } from '../route.ts';
import type { Connection } from '../store.ts';
import {
  outcomeLabel,
  threadChip,
  threadLayout,
  threadTitle,
  wantsStory,
  type LaterItem,
} from '../thread-view.ts';
import { useOlderPosts, type OlderList } from '../useOlderPosts.ts';
import { useView } from '../view-mode.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { Avatar, type Who } from '../components/Avatar.tsx';
import { PostLines, who } from '../components/BoardThread.tsx';
import { Composer } from '../components/Composer.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import { IdText } from '../components/IdText.tsx';
import { PlainToggle } from '../components/PlainToggle.tsx';
import type { LabActions } from './LabHome.tsx';

/** How often an open page reads its thread again, for a story that came and new posts. */
const refreshMs = 30_000;

const noPosts = { posts: [], more: false };

/** The thread, read when the page opens, when `tick` changes, and on `reread`. A read that fails keeps what the page has, and says so. */
function useThread(
  id: string,
  tick: number,
): {
  readonly page: ThreadRecord | null;
  readonly failed: string | null;
  readonly reread: () => void;
} {
  const controls = useContext(ControlsContext);
  const [loaded, setLoaded] = useState<ThreadRecord | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!controls) return;
    const stop = new AbortController();
    void controls
      .threadPage(id, undefined, stop.signal)
      .then((value: Loaded<ThreadRecord>) => {
        if (stop.signal.aborted) return;
        if ('error' in value) setFailed(value.error);
        else {
          setLoaded(value.value);
          setFailed(null);
        }
      });
    return () => stop.abort();
  }, [controls, id, tick, reads]);
  return {
    page: loaded,
    failed,
    reread: useCallback(() => setReads((count) => count + 1), []),
  };
}

function lineWho(line: StoryLine): Who {
  if (line.author === 'person') return 'person';
  return line.harness && line.handle
    ? { harness: line.harness, handle: line.handle }
    : 'verifold';
}

/** A plain line, with its way to the quote. */
function PlainLine({ line }: { readonly line: StoryLine }): ReactNode {
  const { mode } = useView();
  const [original, setOriginal] = useState(false);
  return (
    <>
      <IdText text={lineText(line, mode, original)} />
      {hasOriginal(line, mode) && (
        <>
          {' '}
          <PlainToggle
            original={original}
            onToggle={() => setOriginal(!original)}
          />
        </>
      )}
    </>
  );
}

/** One later fact as a short item. A post clips to two lines, with Show more when it does not fit, and its link stays outside the clip. */
function Later({ item }: { readonly item: LaterItem }): ReactNode {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const element = text.current;
    if (element && !open)
      setClipped(element.scrollHeight > element.clientHeight);
  }, [item.text, open]);
  return (
    <div className="later">
      <p ref={text} className={open || item.line ? undefined : 'later__text'}>
        Later: {item.who && `${item.who}: `}
        {item.line ? <PlainLine line={item.line} /> : item.text}
      </p>
      {(item.post || clipped || open) && (
        <div className="later__links">
          {item.post && <IdText text={item.post} />}
          {(clipped || open) && (
            <button
              type="button"
              className="see"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Simple's story: each step with its time and who did it. */
function Story({
  lines,
  now,
}: {
  readonly lines: readonly StoryLine[];
  readonly now: number;
}): ReactNode {
  return (
    <ol className="story">
      {lines.map((line) => (
        <li key={`${line.at}-${line.posts.join()}`}>
          <span className="story__time">{shortTime(line.at, now)}</span>
          <Avatar who={lineWho(line)} size="sm" />
          <span>
            <PlainLine line={line} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The real posts: each with its kind, time, job, proof, and marks. */
function Posts({
  posts,
  lab,
  onReply,
}: {
  readonly posts: readonly Post[];
  readonly lab: Lab;
  readonly onReply: ((post: Post) => void) | undefined;
}): ReactNode {
  return (
    <div className="posts">
      {posts.map((post) => (
        <article
          key={post.id}
          id={`post-${post.id}`}
          tabIndex={-1}
          className="post"
        >
          <Avatar who={who(post)} size="lg" />
          <div className="post__body">
            <PostLines post={post} lab={lab} onReply={onReply} />
          </div>
        </article>
      ))}
    </div>
  );
}

/**
 * What a thread shows: its state, title, and why, then the outcome, later
 * facts, and how it got there. `threadLayout` holds the rules of each view.
 * `onReply`: reply to a post. Without it, posts have no Reply.
 */
export function ThreadBody({
  page,
  lab,
  older,
  now,
  onReply,
}: {
  readonly page: ThreadRecord;
  readonly lab: Lab;
  readonly older: Pick<
    OlderList,
    'posts' | 'more' | 'gap' | 'busy' | 'problem' | 'show'
  >;
  readonly now: number;
  readonly onReply?: (post: Post) => void;
}): ReactNode {
  const { mode } = useView();
  const { thread } = page;
  const layout = threadLayout(page, older.posts, mode, now);
  const chip = threadChip(thread, lab);
  const label = outcomeLabel(thread, page.takingPart, now);
  return (
    <>
      <h1 className="thread-title">
        <span className={`state state--flat state--${chip.tone}`}>
          {chip.label}
        </span>
        {threadTitle(thread, mode)}
      </h1>
      {thread.why && (
        <p className="why">
          Why this thread: <IdText text={thread.why} />
        </p>
      )}
      {label && (
        <div className="outcome">
          <span className="outcome__label">{label}</span>
          {layout.outcome.length ? (
            layout.outcome.map((line, index) => (
              <p key={index}>
                <PlainLine line={line} />
              </p>
            ))
          ) : (
            <p>
              <IdText text={layout.outcomeQuote ?? ''} />
            </p>
          )}
        </div>
      )}
      {layout.later.map((item) => (
        <Later key={item.key} item={item} />
      ))}
      {layout.stale && <p className="reach">{layout.stale}</p>}
      {layout.steps && <Story lines={layout.steps} now={now} />}
      {layout.note && <p className="reach">{layout.note}</p>}
      {layout.posts.length > 0 && (
        <Posts posts={layout.posts} lab={lab} onReply={onReply} />
      )}
      {older.gap && (
        <p className="turns__none">Reading the posts in between…</p>
      )}
      {older.problem && (
        <p role="alert" className="composer__error">
          {older.problem}
        </p>
      )}
      {!layout.steps && older.more && (
        <button
          type="button"
          className="link-button"
          disabled={older.busy}
          onClick={() => void older.show()}
        >
          Show older posts
        </button>
      )}
      {layout.foot && <p className="reach">{layout.foot}</p>}
    </>
  );
}

/** The box of a thread: a reply to the post that the person chose, or a post in the thread. */
export function ThreadBox({
  lab,
  replyTo,
  onWrite,
  onReply,
  onStop,
  onSent,
}: {
  readonly lab: Lab;
  readonly replyTo: Post | null;
  readonly onWrite: (text: string, key: string) => Promise<ActOutcome>;
  readonly onReply: (
    post: string,
    text: string,
    key: string,
  ) => Promise<ActOutcome>;
  readonly onStop: () => void;
  readonly onSent: () => void;
}): ReactNode {
  return (
    <Composer
      label="Write to this thread"
      placeholder="Write to this thread"
      maxLength={lab.postLimit}
      names={mentionNames(lab)}
      onSend={(text, key) =>
        replyTo ? onReply(replyTo.id, text, key) : onWrite(text, key)
      }
      replying={
        replyTo
          ? {
              post: replyTo.id,
              to: authorOf(replyTo),
              text: cut(replyTo.text, 80),
              onStop,
            }
          : undefined
      }
      onSent={onSent}
    />
  );
}

/**
 * One thread's page, as in step 2 of the v10 spec, with Reply on each post and
 * a box that writes to the thread. In Simple it asks once for a story that the
 * thread lacks. PR 6 of v10 adds who a message reaches and the other levels.
 */
export function ThreadPage({
  snapshot,
  lab,
  id,
  connection,
  now,
  actions,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly id: string;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
}): ReactNode {
  const { mode } = useView();
  const controls = useContext(ControlsContext);
  const { page, failed, reread } = useThread(id, Math.floor(now / refreshMs));
  const read = useCallback(
    (before: string, signal?: AbortSignal) =>
      controls
        ? controls.threadPage(id, before, signal)
        : Promise.resolve({ error: 'This page cannot read older posts.' }),
    [controls, id],
  );
  const older = useOlderPosts(page ?? noPosts, controls ? read : null);
  const wanted = page && lab.agentsHere && wantsStory(page, mode);
  // Once for each opening: a thread that grows while it is open waits for its next opening.
  const asked = useRef(false);
  useEffect(() => {
    if (!wanted || asked.current) return;
    asked.current = true;
    void controls?.askStory(id);
  }, [wanted, controls, id]);
  const [replyTo, setReplyTo] = useState<Post | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const writes = controls && lab.agentsHere ? controls : null;
  return (
    <div className="page">
      <AppHeader
        project={snapshot.project}
        own={snapshot.ownProfile === true}
        lab={lab}
        now={now}
        onPause={actions.pause}
      />
      <main className="main">
        <div className="column column--lab">
          <ConnectionBar connection={connection} at={snapshot.at} />
          <a className="back" href={href.lab}>
            <Chevron to="left" />
            The lab
          </a>
          {failed && (
            <p role="alert" className="composer__error">
              {failed}
            </p>
          )}
          {page ? (
            <ThreadBody
              page={page}
              lab={lab}
              older={older}
              now={now}
              {...(writes
                ? {
                    onReply: (post: Post) => {
                      setReplyTo(post);
                      box.current?.querySelector('input')?.focus();
                    },
                  }
                : {})}
            />
          ) : (
            !failed && <p className="turns__none">Reading the thread…</p>
          )}
          {page && writes && (
            <div ref={box}>
              <ThreadBox
                lab={lab}
                replyTo={replyTo}
                onWrite={(text, key) => writes.writeThread(id, text, key)}
                onReply={writes.reply}
                onStop={() => setReplyTo(null)}
                onSent={() => {
                  setReplyTo(null);
                  reread();
                }}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
