import type {
  Lab,
  Post,
  StoryLine,
  Thread,
  ThreadPage,
} from '../protocol/api.ts';
import { agentsWord, type Chip } from './agent-rows.ts';
import { clock, roleName } from './format.ts';
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

const outcomeWords: Readonly<Record<Thread['state'], string>> = {
  open: 'Outcome',
  decided: 'Decision',
  answered: 'Answer',
  closed: 'Outcome',
};

/** Who took part in a thread: "Agents 1, 2 and 3, after your request". The posts name them, and a thread that the person opened says so. */
function takingPart(posts: readonly Post[]): string {
  const agents = [...new Set(posts.flatMap((post) => post.handle ?? []))].sort(
    (a, b) => a.localeCompare(b, 'en', { numeric: true }),
  );
  const asked = posts[0]?.author === 'person';
  if (!agents.length) return asked ? 'You' : 'Verifold';
  return `${agentsWord(agents)}${asked ? ', after your request' : ''}`;
}

/** The label of an outcome: what it is, when, and who took part. Null with no outcome. `posts`: the thread's, oldest first. */
export function outcomeLabel(
  thread: Thread,
  posts: readonly Post[],
): string | null {
  const { outcome } = thread;
  return outcome
    ? `${outcomeWords[thread.state]} · ${clock(outcome.at)} · ${takingPart(posts)}`
    : null;
}

/** What a page tells of a story: its steps, its outcome lines, its later lines, and the posts that came after it. */
export interface StoryParts {
  readonly steps: readonly StoryLine[];
  readonly outcome: readonly StoryLine[];
  readonly later: readonly StoryLine[];
  readonly newer: readonly Post[];
}

const number = (id: string): number => Number(id.slice(2));

export function storyParts(page: ThreadPage): StoryParts {
  const { story, posts } = page;
  const lines = story?.lines ?? [];
  const through = story ? number(story.through) : Infinity;
  return {
    steps: lines.filter((line) => line.kind === 'step'),
    outcome: lines.filter((line) => line.kind === 'outcome'),
    later: lines.filter((line) => line.kind === 'later'),
    newer: posts.filter((post) => number(post.id) > through),
  };
}

/** The later facts that the record shows and no story line cites. */
export function laterFromRecord(page: ThreadPage): readonly Post[] {
  const told = new Set(
    (page.story?.lines ?? [])
      .filter((line) => line.kind === 'later')
      .flatMap((line) => line.posts),
  );
  return (page.later ?? []).filter((post) => !told.has(post.id));
}

/** A later post in words: who, when, and what it says. */
export function laterLine(post: Post): string {
  return `${post.handle ? roleName(post.handle) : post.author === 'person' ? 'You' : 'Verifold'}, ${clock(post.at)}: ${post.text}`;
}

/** The person asks for a story of an open page that Simple shows with none, or with newer posts past it. */
export function wantsStory(page: ThreadPage, mode: ViewMode): boolean {
  if (mode !== 'simple' || !page.posts.length) return false;
  return !page.story || storyParts(page).newer.length > 0;
}

/** Simple shows the agents' posts. Verifold's own lines carry IDs and say what the outcome and the record say. */
export function simplePosts(posts: readonly Post[]): readonly Post[] {
  return posts.filter((post) => post.author !== 'verifold');
}
