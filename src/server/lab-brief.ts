/**
 * The brief, the notices, and the questions on the wire. Verifold builds the
 * quote, the evidence label, and the top line here from the records as they
 * are now, so a label follows a later check. Plain words go out only once they
 * passed their check: a line that failed, or that waits, carries its quote.
 */
import type { Post as BoardPost } from '../core/board.ts';
import {
  briefTop,
  evidenceLabel,
  evidencePosts,
  quoteOf,
} from '../core/lab/brief.ts';
import type { BriefLine as StoredLine, LabView } from '../core/lab/schema.ts';
import type {
  Brief,
  BriefLine,
  LabList,
  Notice,
  Question,
} from '../protocol/api.ts';

/** A line as the wire has it. */
function lineItem(
  line: StoredLine,
  view: LabView,
  posts: ReadonlyMap<string, BoardPost>,
): BriefLine {
  const cited = line.posts.flatMap((id) => posts.get(id) ?? []);
  const { state, by, sameHarness } = line.check;
  return {
    kind: line.kind,
    at: line.at,
    plain: state === 'passed' ? line.plain : null,
    quote: quoteOf(cited),
    posts: [...line.posts],
    evidence: evidenceLabel(evidencePosts(cited, view.posts), view.checks),
    check: { state, by, sameHarness },
  };
}

/**
 * The fields of a lab's snapshot. `keep` cuts a list to its level. A lab from
 * before threads has none.
 */
export function briefItems(
  view: LabView,
  keep: <T>(list: readonly T[], name: LabList) => T[],
): {
  readonly brief: Brief | null;
  readonly notices: readonly Notice[];
  readonly questions: readonly Question[];
} {
  const stored = view.brief;
  if (!stored) return { brief: null, notices: [], questions: [] };
  const posts = new Map(view.posts.map((post) => [post.id, post]));
  return {
    brief: {
      at: stored.brief?.at ?? null,
      top: briefTop({
        directions: view.state.directions,
        calls: view.state.calls,
        runs: view.ledger,
      }),
      lines: keep(stored.brief?.lines ?? [], 'briefLines').map((line) =>
        lineItem(line, view, posts),
      ),
    },
    notices: keep(stored.notices, 'notices').map((notice) => ({
      id: notice.id,
      at: notice.at,
      kind: notice.kind,
      posts: [...notice.posts],
      to: [...notice.to],
    })),
    questions: keep(stored.questions, 'questions').map((question) => ({
      id: question.id,
      at: question.at,
      text: question.text,
      state: question.state,
      answer: question.answer ? lineItem(question.answer, view, posts) : null,
    })),
  };
}
