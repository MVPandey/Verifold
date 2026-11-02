import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  Lab,
  Post,
  Snapshot,
  StoryLine,
  ThreadPage as ThreadRecord,
} from '../../protocol/api.ts';
import type { Loaded } from '../api.ts';
import { byNumber } from '../board.ts';
import { lineText } from '../brief-view.ts';
import { ControlsContext } from '../controls.ts';
import { clock } from '../format.ts';
import { href } from '../route.ts';
import type { Connection } from '../store.ts';
import {
  laterFromRecord,
  laterLine,
  outcomeLabel,
  simplePosts,
  storyParts,
  threadChip,
  threadTitle,
  wantsStory,
} from '../thread-view.ts';
import { useView } from '../view-mode.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { Avatar, type Who } from '../components/Avatar.tsx';
import { PostLines, who } from '../components/BoardThread.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import { IdText } from '../components/IdText.tsx';
import { PlainToggle } from '../components/PlainToggle.tsx';
import type { LabActions } from './LabHome.tsx';

/** How often an open page reads its thread again, for a story that came and new posts. */
const refreshMs = 30_000;

/** The thread, read when the page opens and again every `refreshMs`. A read that fails keeps what the page has. */
function useThread(
  id: string,
  now: number,
): { readonly loaded: Loaded<ThreadRecord> | null; readonly older: Older } {
  const controls = useContext(ControlsContext);
  const [loaded, setLoaded] = useState<Loaded<ThreadRecord> | null>(null);
  const [older, setOlder] = useState<{
    readonly posts: readonly Post[];
    readonly more: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const tick = Math.floor(now / refreshMs);
  useEffect(() => {
    if (!controls) return;
    const stop = new AbortController();
    void controls.threadPage(id, undefined, stop.signal).then((value) => {
      if (stop.signal.aborted) return;
      setLoaded((last) =>
        'error' in value && last && 'value' in last ? last : value,
      );
    });
    return () => stop.abort();
  }, [controls, id, tick]);
  const page = loaded && 'value' in loaded ? loaded.value : null;
  const first = older?.posts[0] ?? page?.posts[0];
  return {
    loaded,
    older: {
      posts: older?.posts ?? [],
      more: older ? older.more : (page?.more ?? false),
      busy,
      show: () => {
        if (!controls || !first || busy) return;
        setBusy(true);
        void controls.threadPage(id, first.id).then((value) => {
          setBusy(false);
          if ('value' in value)
            setOlder({
              posts: byNumber([value.value.posts, older?.posts ?? []]),
              more: value.value.more,
            });
        });
      },
    },
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
      {mode === 'simple' && line.plain !== null && (
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

/** Simple's story: each step with its time and who did it. */
function Story({ lines }: { readonly lines: readonly StoryLine[] }): ReactNode {
  return (
    <ol className="story">
      {lines.map((line) => (
        <li key={`${line.at}-${line.posts.join()}`}>
          <span className="story__time">{clock(line.at)}</span>
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
}: {
  readonly posts: readonly Post[];
  readonly lab: Lab;
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
            <PostLines post={post} lab={lab} />
          </div>
        </article>
      ))}
    </div>
  );
}

/** The older posts that a page read, and how to read more. */
interface Older {
  readonly posts: readonly Post[];
  readonly more: boolean;
  readonly busy: boolean;
  readonly show: () => void;
}

/**
 * What a thread shows: its state, title, and why, then the outcome, later
 * facts, and how it got there. Simple tells the story, and Technical shows the
 * real posts. With no story yet, or for posts newer than the story, Simple
 * shows the posts too.
 */
export function ThreadBody({
  page,
  lab,
  older,
}: {
  readonly page: ThreadRecord;
  readonly lab: Lab;
  readonly older: Older;
}): ReactNode {
  const { mode } = useView();
  const { thread, posts, story } = page;
  const parts = storyParts(page);
  const chip = threadChip(thread, lab);
  const all = byNumber([older.posts, posts]);
  const label = outcomeLabel(thread, all);
  const fromRecord = laterFromRecord(page);
  const told = mode === 'simple' && story;
  const shown = mode === 'simple' ? simplePosts(all) : all;
  const count = thread.posts ?? posts.length;
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
      {thread.outcome && label && (
        <div className="outcome">
          <span className="outcome__label">{label}</span>
          {told && parts.outcome.length ? (
            parts.outcome.map((line, index) => (
              <p key={index}>
                <PlainLine line={line} />
              </p>
            ))
          ) : (
            <p>
              <IdText
                text={
                  mode === 'technical'
                    ? `${thread.outcome.text} (${thread.outcome.post})`
                    : thread.outcome.text
                }
              />
            </p>
          )}
        </div>
      )}
      {parts.later.map((line, index) => (
        <div key={index} className="later">
          Later: <PlainLine line={line} />
        </div>
      ))}
      {fromRecord.map((post) => (
        <div key={post.id} className="later">
          Later: <IdText text={laterLine(post)} />
        </div>
      ))}
      {told && <Story lines={parts.steps} />}
      {told && parts.newer.length > 0 && (
        <p className="reach">
          This story ends at its last step. {parts.newer.length} newer{' '}
          {parts.newer.length === 1 ? 'post follows' : 'posts follow'}.
        </p>
      )}
      {mode === 'simple' && !story && (
        <p className="reach">
          The story of this thread is not ready yet. Here are its posts.
        </p>
      )}
      {!all.length && <p className="reach">This thread has no posts yet.</p>}
      {!told ? (
        <Posts posts={shown} lab={lab} />
      ) : (
        parts.newer.length > 0 && (
          <Posts posts={simplePosts(parts.newer)} lab={lab} />
        )
      )}
      {!told && older.more && (
        <button
          type="button"
          className="link-button"
          disabled={older.busy}
          onClick={older.show}
        >
          Show older posts
        </button>
      )}
      {told && count > 0 && (
        <p className="reach">
          The thread has {count} {count === 1 ? 'post' : 'posts'}. Technical
          shows {count === 1 ? 'it' : 'each one'}.
        </p>
      )}
    </>
  );
}

/**
 * One thread's page, as in step 2 of the v10 spec. It reads the thread, and in
 * Simple it asks once for a story that the thread lacks.
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
  const { loaded, older } = useThread(id, now);
  const page = loaded && 'value' in loaded ? loaded.value : null;
  const wanted = page && lab.agentsHere && wantsStory(page, mode);
  // Once for each opening: a thread that grows while it is open must not use up the updates of the brief.
  const asked = useRef(false);
  useEffect(() => {
    if (!wanted || asked.current) return;
    asked.current = true;
    void controls?.askStory(id);
  }, [wanted, controls, id]);
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
          {page ? (
            <ThreadBody page={page} lab={lab} older={older} />
          ) : loaded && 'error' in loaded ? (
            <p role="alert" className="turns__none">
              {loaded.error}
            </p>
          ) : (
            <p className="turns__none">Reading the thread…</p>
          )}
        </div>
      </main>
    </div>
  );
}
