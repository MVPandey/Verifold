/**
 * The brief, the notices, and the questions on the wire. Verifold builds the
 * quote, the evidence label, and the top line here from the records as they
 * are now, so a label follows a later check. Plain words go out only once they
 * passed their check: a line that failed, or that waits, carries its quote.
 */
import type { Post as BoardPost } from '../core/board.ts';
import {
  briefTop,
  briefTopIds,
  evidenceLabel,
  evidencePosts,
  plainNumbersMatch,
  quotesOf,
} from '../core/lab/brief.ts';
import { noticeStands } from '../core/lab/coordinator-rules.ts';
import { endedWhy } from '../core/lab/reach.ts';
import { openWaits } from '../core/lab/waits.ts';
import type {
  BriefLine as StoredLine,
  LabView,
  Notice as StoredNotice,
} from '../core/lab/schema.ts';
import type {
  Brief,
  BriefLine,
  LabList,
  Notice,
  Question,
  ThreadStory,
} from '../protocol/api.ts';

/** The person can act on a notice: agents may do the same work, or no agent answered the person. */
function concernsPerson(
  notice: Pick<StoredNotice, 'kind' | 'posts'>,
  posts: ReadonlyMap<string, BoardPost>,
): boolean {
  return (
    notice.kind === 'overlap' ||
    (notice.kind === 'missing-answer' &&
      notice.posts.some((id) => posts.get(id)?.author === 'person'))
  );
}

/** Which notices the records still hold. It reads the records only when a lab has notices. */
function standingNotices(view: LabView): (notice: StoredNotice) => boolean {
  if (!view.brief?.notices.length) return () => false;
  const waits = openWaits(view.posts, view.threads ?? []);
  const working = new Set(
    view.directions
      .filter(({ status }) => !endedWhy(status))
      .map(({ agent }) => agent.id),
  );
  return (notice) => noticeStands(notice, waits, working);
}

/** A line as the wire has it. */
function lineItem(
  line: StoredLine,
  view: LabView,
  posts: ReadonlyMap<string, BoardPost>,
): BriefLine {
  const cited = line.posts.flatMap((id) => posts.get(id) ?? []);
  const { by, sameHarness } = line.check;
  // The file can change after a check, so the numbers are tested again on the way out.
  const state =
    line.check.state === 'passed' && !plainNumbersMatch(line.plain, cited)
      ? 'numbers'
      : line.check.state;
  return {
    kind: line.kind,
    at: line.at,
    plain: state === 'passed' ? line.plain : null,
    quotes: quotesOf(cited),
    posts: [...line.posts],
    thread: cited.find((post) => post.thread)?.thread ?? null,
    evidence: evidenceLabel(evidencePosts(cited, view.posts), view.checks),
    check: { state, by, sameHarness },
  };
}

/**
 * The fields of a lab's snapshot. `keep` cuts a list to its level, from its
 * start or, with `newest`, from its end. A brief's first lines come first, so
 * a smaller snapshot keeps them. A lab from before threads has none.
 */
export function briefItems(
  view: LabView,
  keep: <T>(list: readonly T[], name: LabList, newest: boolean) => T[],
): {
  readonly brief: Brief | null;
  readonly notices: readonly Notice[];
  readonly questions: readonly Question[];
} {
  const stored = view.brief;
  if (!stored) return { brief: null, notices: [], questions: [] };
  const posts = new Map(view.posts.map((post) => [post.id, post]));
  const stands = standingNotices(view);
  const records = {
    directions: view.state.directions,
    calls: view.state.calls,
    runs: view.ledger,
  };
  return {
    brief: {
      at: stored.brief?.at ?? null,
      top: briefTop(records),
      topIds: briefTopIds(records),
      lines: keep(stored.brief?.lines ?? [], 'briefLines', false).map((line) =>
        lineItem(line, view, posts),
      ),
    },
    notices: keep(stored.notices, 'notices', true).map((notice) => ({
      id: notice.id,
      at: notice.at,
      kind: notice.kind,
      posts: [...notice.posts],
      to: [...notice.to],
      forYou: concernsPerson(notice, posts) && stands(notice),
      thread:
        notice.posts.flatMap((id) => posts.get(id)?.thread ?? [])[0] ?? null,
    })),
    questions: keep(stored.questions, 'questions', true).map((question) => ({
      id: question.id,
      at: question.at,
      text: question.text,
      state: question.state,
      answer: question.answer ? lineItem(question.answer, view, posts) : null,
    })),
  };
}

/** A thread's story on the wire, or null when it has none. A line shows who wrote its first cited post. */
export function storyItem(view: LabView, thread: string): ThreadStory | null {
  const stored = view.brief?.stories.find((story) => story.thread === thread);
  if (!stored) return null;
  const posts = new Map(view.posts.map((post) => [post.id, post]));
  return {
    at: stored.at,
    posts: [...stored.posts],
    outcome: stored.outcome,
    lines: stored.lines.map((line) => {
      const first = posts.get(line.posts[0] ?? '');
      const author = first?.author ?? 'verifold';
      return {
        ...lineItem(line, view, posts),
        author,
        handle: view.handles[author] ?? null,
        harness: first?.harness ?? null,
      };
    }),
  };
}
