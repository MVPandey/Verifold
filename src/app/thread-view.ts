import type {
  Lab,
  Post,
  StoryLine,
  TakingPart,
  Thread,
  ThreadPage,
} from '../protocol/api.ts';
import { agentsWord, type Chip } from './agent-rows.ts';
import { roleName, shortTime } from './format.ts';
import type { ViewMode } from './view-mode.ts';

/** The title that a view shows. The Coordinator's plain title is for the person, and Technical shows the agents' own. */
export function threadTitle(thread: Thread, mode: ViewMode): string {
  return mode === 'simple' ? (thread.plainTitle ?? thread.title) : thread.title;
}

/** A thread's state chip. An open thread whose direction has a run in progress shows that. */
export function threadChip(
  thread: Pick<Thread, 'state' | 'direction'>,
  lab: Pick<Lab, 'runs'>,
): Chip {
  switch (thread.state) {
    case 'decided':
      return { label: 'Decided', tone: 'ok' };
    case 'answered':
      return { label: 'Answered', tone: 'ok' };
    case 'closed':
      return { label: 'Closed', tone: 'done' };
    case 'open':
      return lab.runs.some(
        (run) => run.direction === thread.direction && run.status === 'running',
      )
        ? { label: 'Running', tone: 'run' }
        : { label: 'Open', tone: 'open' };
  }
}

const groups: readonly { state: Thread['state']; label: string }[] = [
  { state: 'open', label: 'Open' },
  { state: 'decided', label: 'Decided' },
  { state: 'answered', label: 'Answered' },
  { state: 'closed', label: 'Closed' },
];

/** The newest talk first. */
function byActivity(threads: readonly Thread[]): readonly Thread[] {
  return [...threads].sort((a, b) =>
    (b.lastAt ?? b.at).localeCompare(a.lastAt ?? a.at),
  );
}

/** Threads by state, open first, each list with the newest talk first. A state with no thread does not show. */
export function threadGroups(threads: readonly Thread[]): readonly {
  readonly label: string;
  readonly threads: readonly Thread[];
}[] {
  return groups.flatMap(({ state, label }) => {
    const own = threads.filter((thread) => thread.state === state);
    return own.length ? [{ label, threads: byActivity(own) }] : [];
  });
}

/** The open threads for the home: the newest talk first, at most `limit`. */
export function openThreads(
  threads: readonly Thread[],
  limit: number,
): readonly Thread[] {
  return byActivity(threads.filter((thread) => thread.state === 'open')).slice(
    0,
    limit,
  );
}

const counted = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

/** "6 posts": a thread's posts. */
export function postCount(thread: Pick<Thread, 'posts'>): string {
  return counted(thread.posts ?? 0, 'post');
}

/** "All 14 threads": the threads of a lab, also those that the snapshot leaves out. */
export function allThreads(lab: Pick<Lab, 'threads' | 'omitted'>): string {
  const total = (lab.threads?.length ?? 0) + (lab.omitted.threads ?? 0);
  return `All ${counted(total, 'thread')}`;
}

const outcomeWords: Readonly<Record<Thread['state'], string>> = {
  open: 'Outcome',
  decided: 'Decision',
  answered: 'Answer',
  closed: 'Outcome',
};

/** Who took part: "Agents 1, 2 and 3, after your request". */
function takingPartWords(part: TakingPart | undefined): string {
  if (!part?.handles.length) return part?.byPerson ? 'You' : 'Verifold';
  return `${agentsWord(part.handles)}${part.byPerson ? ', after your request' : ''}`;
}

/** The label of an outcome: what it is, when, and who took part, from the server's record of the whole thread. Null with no outcome. */
export function outcomeLabel(
  thread: Thread,
  part: TakingPart | undefined,
  now: number,
): string | null {
  const { outcome } = thread;
  return outcome
    ? `${outcomeWords[thread.state]} · ${shortTime(outcome.at, now)} · ${takingPartWords(part)}`
    : null;
}

/** A later fact under an outcome, as one short item. */
export interface LaterItem {
  readonly key: string;
  /** A plain line of the story, with its way to its quote. */
  readonly line: StoryLine | null;
  /** Who wrote it and when. Null: a plain line, or a quote of a line. */
  readonly who: string | null;
  readonly text: string;
  /** Its post, for its link in the Technical view. */
  readonly post: string | null;
}

/** What a thread's page shows in a view. */
export interface ThreadLayout {
  /** Simple's story. Null: the page shows posts. */
  readonly steps: readonly StoryLine[] | null;
  /** The plain lines of the outcome. Empty: the outcome shows its quote. */
  readonly outcome: readonly StoryLine[];
  /** The outcome's quote. An ID follows it only in Technical. */
  readonly outcomeQuote: string | null;
  readonly later: readonly LaterItem[];
  /** One line above the story: it tells an earlier outcome. Null: it does not. */
  readonly stale: string | null;
  /** One line above the posts, or null. */
  readonly note: string | null;
  readonly posts: readonly Post[];
  /** One line at the end, or null. */
  readonly foot: string | null;
  /** The words of the control that opens the story's posts here. Null: none. */
  readonly showPosts: string | null;
}

/** A story tells the outcome that the thread has now. */
function storyIsCurrent(page: ThreadPage): boolean {
  return (
    !page.story || page.story.outcome === (page.thread.outcome?.post ?? null)
  );
}

/** The posts of `posts` that the story's session did not read: newer posts, and posts that moved in. */
function outsideStory(
  page: ThreadPage,
  posts: readonly Post[],
): readonly Post[] {
  const covered = new Set(page.story?.posts);
  return posts.filter((post) => !covered.has(post.id));
}

function laterItems(
  page: ThreadPage,
  mode: ViewMode,
  now: number,
): readonly LaterItem[] {
  const lines = storyIsCurrent(page)
    ? (page.story?.lines ?? []).filter((line) => line.kind === 'later')
    : [];
  const told = new Set(lines.flatMap((line) => line.posts));
  return [
    ...lines.flatMap((line, index): readonly LaterItem[] =>
      mode === 'simple'
        ? [
            {
              key: `line-${index}`,
              line,
              who: null,
              text: line.plain ?? '',
              post: null,
            },
          ]
        : line.quotes.map(({ post, text }) => ({
            key: `line-${index}-${post}`,
            line: null,
            who: null,
            text,
            post,
          })),
    ),
    ...(page.later ?? [])
      .filter((post) => !told.has(post.id))
      .map((post) => ({
        key: post.id,
        line: null,
        who: `${post.handle ? roleName(post.handle) : post.author === 'person' ? 'You' : 'Verifold'}, ${shortTime(post.at, now)}`,
        text: post.text,
        post: mode === 'technical' ? post.id : null,
      })),
  ];
}

/** Simple shows the agents' posts. Verifold's own lines carry IDs and say what the outcome and the record say. */
function simplePosts(posts: readonly Post[]): readonly Post[] {
  return posts.filter((post) => post.author !== 'verifold');
}

function outsideNote(left: number): string | null {
  if (!left) return null;
  return left === 1
    ? '1 post is not in this story. It follows.'
    : `${left} posts are not in this story. They follow.`;
}

/**
 * What a thread's page shows. Simple tells the story, unless the thread has
 * none yet, and Technical shows the real posts. A story that tells an earlier
 * outcome stays, but the current outcome's quote stands above it, and both
 * views leave out its later lines. `posts`: each post that the page read.
 * `unfolded`: the person opened the story's posts, to act on one of them.
 */
export function threadLayout(
  page: ThreadPage,
  posts: readonly Post[],
  mode: ViewMode,
  now: number,
  unfolded = false,
): ThreadLayout {
  const { thread, story } = page;
  const told = mode === 'simple' && story ? story : null;
  const current = storyIsCurrent(page);
  const lines = current
    ? (told?.lines.filter((line) => line.kind === 'outcome') ?? [])
    : [];
  const left = told ? simplePosts(outsideStory(page, posts)) : [];
  const count = thread.posts ?? posts.length;
  return {
    steps: told?.lines.filter((line) => line.kind === 'step') ?? null,
    outcome: lines,
    outcomeQuote: thread.outcome
      ? mode === 'technical'
        ? `${thread.outcome.text} (${thread.outcome.post})`
        : thread.outcome.text
      : null,
    later: laterItems(page, mode, now),
    stale:
      told && !current
        ? "This story is out of date: the thread's outcome changed."
        : null,
    note: told
      ? outsideNote(left.length)
      : mode === 'simple'
        ? 'The story of this thread is not ready yet. Here are its posts.'
        : null,
    posts:
      told && !unfolded ? left : mode === 'simple' ? simplePosts(posts) : posts,
    foot:
      told && count
        ? `The thread has ${counted(count, 'post')}. Technical shows ${count === 1 ? 'it' : 'each one'}.`
        : !posts.length
          ? 'This thread has no posts yet.'
          : null,
    showPosts:
      told && !unfolded && count
        ? `Show ${count === 1 ? 'the post' : 'the posts'} here`
        : null,
  };
}

/** The person can overturn a thread that has a decision. */
export function canOverturn(thread: Pick<Thread, 'state'>): boolean {
  return thread.state === 'decided';
}

/** The person asks for a story of an open page that Simple shows with none, with an earlier outcome, or with posts outside it. The server decides whether one is due. */
export function wantsStory(page: ThreadPage, mode: ViewMode): boolean {
  if (mode !== 'simple' || !page.posts.length) return false;
  return (
    !page.story ||
    !storyIsCurrent(page) ||
    outsideStory(page, page.posts).length > 0
  );
}
