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
import { hasOriginal, lineText } from '../brief-view.ts';
import { ControlsContext } from '../controls.ts';
import { shortTime } from '../format.ts';
import { href } from '../route.ts';
import { threadActs, workNote, type BoxAct } from '../step-in.ts';
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
import { useRead } from '../useRead.ts';
import { useView, type ViewMode } from '../view-mode.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { Avatar, type Who } from '../components/Avatar.tsx';
import { PostLines, who } from '../components/BoardThread.tsx';
import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import { IdText } from '../components/IdText.tsx';
import { PlainToggle } from '../components/PlainToggle.tsx';
import { StepInBox } from '../components/StepInBox.tsx';
import {
  Answers,
  NoticeLines,
  PostActs,
  PriorBlock,
} from '../components/StepInParts.tsx';
import type { LabActions } from './LabHome.tsx';

/** How often an open page reads its thread again, for a story that came and new posts. */
const refreshMs = 30_000;

const noPosts = { posts: [], more: false };

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

/** The real posts: each with its kind, time, job, proof, marks, prior work, and what the person can do. */
function Posts({
  posts,
  lab,
  now,
  onAct,
}: {
  readonly posts: readonly Post[];
  readonly lab: Lab;
  readonly now: number;
  readonly onAct: ((act: BoxAct) => void) | undefined;
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
            <PriorBlock post={post} now={now} />
            {onAct && <PostActs post={post} onAct={onAct} />}
          </div>
        </article>
      ))}
    </div>
  );
}

/** Overturn a decision: the person's word on a proposal that decided a thread. */
function Overturn({
  thread,
  onDone,
}: {
  readonly thread: string;
  readonly onDone: () => void;
}): ReactNode {
  const controls = useContext(ControlsContext);
  if (!controls) return null;
  return (
    <div className="acts acts--flat">
      <ConfirmButton
        className="act"
        label="Overturn this decision"
        confirm="Click again to overturn it"
        run={(key) => controls.overturn(thread, key)}
        onDone={onDone}
      />
    </div>
  );
}

/**
 * What a thread shows: its state, title, and why, then the outcome, later
 * facts, and how it got there. `threadLayout` holds the rules of each view.
 * `onAct`: reply or object to a post. Without it, posts have no controls.
 */
export function ThreadBody({
  page,
  lab,
  older,
  now,
  onAct,
  onChanged,
}: {
  readonly page: ThreadRecord;
  readonly lab: Lab;
  readonly older: Pick<
    OlderList,
    'posts' | 'more' | 'gap' | 'busy' | 'problem' | 'show'
  >;
  readonly now: number;
  readonly onAct?: (act: BoxAct) => void;
  readonly onChanged?: () => void;
}): ReactNode {
  const { mode } = useView();
  const { thread } = page;
  // A new view starts with the story's posts folded.
  const [unfolded, setUnfolded] = useState<ViewMode | null>(null);
  const layout = threadLayout(page, older.posts, mode, now, unfolded === mode);
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
      {onAct && thread.state === 'decided' && (
        <Overturn thread={thread.id} onDone={() => onChanged?.()} />
      )}
      {thread.overturned && (
        <p className="reach">
          You overturned this thread's decision
          {mode === 'technical' ? (
            <>
              {' '}
              <IdText text={thread.overturned} />
            </>
          ) : null}
          .
        </p>
      )}
      {layout.later.map((item) => (
        <Later key={item.key} item={item} />
      ))}
      {layout.stale && <p className="reach">{layout.stale}</p>}
      {layout.steps && <Story lines={layout.steps} now={now} />}
      {layout.note && <p className="reach">{layout.note}</p>}
      {layout.posts.length > 0 && (
        <Posts posts={layout.posts} lab={lab} now={now} onAct={onAct} />
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
      {layout.showPosts && (
        <button type="button" className="see" onClick={() => setUnfolded(mode)}>
          {layout.showPosts}
        </button>
      )}
    </>
  );
}

/** Stop and Reopen beside the box. Stop asks to confirm. Reopen wakes a closed agent with this thread. */
function ThreadWork({
  page,
  lab,
  posts,
}: {
  readonly page: ThreadRecord;
  readonly lab: Lab;
  readonly posts: readonly Post[];
}): ReactNode {
  const controls = useContext(ControlsContext);
  const acts = threadActs(page.thread, posts, lab);
  const { stop, reopen } = acts;
  if (!controls || (!stop.length && !reopen.length)) return null;
  return (
    <>
      <div className="acts acts--flat">
        {stop.map(({ direction, name }) => (
          <ConfirmButton
            key={direction.id}
            className="act"
            label={`Stop ${name}'s work`}
            confirm={`Click again to stop ${name}`}
            run={(key) => controls.stopDirection(direction.id, key)}
          />
        ))}
        {reopen.map(({ direction, name }) => (
          <ConfirmButton
            key={direction.id}
            className="act"
            label={`Reopen ${name}'s work`}
            confirm={`Click again to reopen ${name}`}
            run={(key) =>
              controls.reopenDirection(direction.id, page.thread.id, key)
            }
          />
        ))}
      </div>
      <p className="reach">{workNote(acts)}</p>
    </>
  );
}

/**
 * One thread's page, as in steps 2 and 4 of the v10 spec: the thread, the
 * person's controls on each post, the Coordinator's answers, the box with its
 * levels and its reach line, and Stop and Reopen. In Simple it asks once for a
 * story that the thread lacks.
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
  const load = useCallback(
    (signal: AbortSignal) =>
      controls
        ? controls.threadPage(id, undefined, signal)
        : Promise.resolve({ error: 'This page cannot read the thread.' }),
    [controls, id],
  );
  const {
    value: page,
    failed,
    reread,
  } = useRead(controls ? load : null, Math.floor(now / refreshMs));
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
  const [act, setAct] = useState<BoxAct | null>(null);
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
              onChanged={reread}
              {...(writes
                ? {
                    onAct: (next: BoxAct) => {
                      setAct(next);
                      box.current?.querySelector('input')?.focus();
                    },
                  }
                : {})}
            />
          ) : (
            !failed && <p className="turns__none">Reading the thread…</p>
          )}
          <NoticeLines lab={lab} thread={id} />
          <Answers lab={lab} now={now} />
          {page && writes && (
            <>
              <div ref={box}>
                <StepInBox
                  lab={lab}
                  thread={
                    lab.threads?.find(({ id: own }) => own === id) ??
                    page.thread
                  }
                  posts={older.posts}
                  act={act}
                  tick={snapshot.at}
                  now={now}
                  onStopAct={() => setAct(null)}
                  onSent={() => {
                    setAct(null);
                    reread();
                  }}
                />
              </div>
              <ThreadWork page={page} lab={lab} posts={older.posts} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
