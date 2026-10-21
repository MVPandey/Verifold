import type { LabView, Verdict } from './lab.ts';
import { authorName, counted, verdictText } from './lab-words.ts';
import { usd } from './leases.ts';

/**
 * What changed while the person was away from the lab. The desk's Home and
 * the API's snapshot both say it, from the same lab view, so the two show
 * the same news in the same words.
 */

/** When the person left the lab, and the header's two costs then: Claude Code's estimate and the pods'. */
export interface Away {
  readonly since: string;
  readonly spent: { readonly claude: number; readonly gpu: number };
}

/** Directions that the digest names. Their rows show the rest. */
export const awayLines = 5;

/** Failed runs that the digest names. The run ledger has the rest. */
export const awayRuns = 5;

/** A direction with news since the person left. */
export interface AwayLine {
  readonly direction: string;
  readonly title: string;
  /** The mark of its row: its verdict, an open dispute, or `new` for a direction opened meanwhile that is still open. */
  readonly mark: Verdict | 'disputed' | 'new';
  /** What changed, in words, such as "Holds up (acc 0.7). 2 new posts." */
  readonly said: string;
}

export interface AwayNews {
  /** Every direction with news: a dispute first, then the most settled. A direction that ended comes last. */
  readonly lines: readonly AwayLine[];
  /** Posts that came, apart from Verifold's notes. */
  readonly posts: number;
  /** Runs that ended. */
  readonly runsEnded: number;
  /** The runs among them that failed or ran out of time. */
  readonly runsFailed: readonly string[];
  /** Calls that came for the person. */
  readonly calls: number;
  /**
   * What the lab spent since then, such as "Spent since then: ≈$1.20
   * (Claude Code ≈$0.70, GPU $0.50).", or "" under a cent. The costs add up
   * to the header's growth since then.
   */
  readonly cost: string;
}

/**
 * The news since `away.since`. `gpu`: what the lab's pods cost so far, or
 * null when this Verifold has no pods. `disputed`: the posts in open
 * dispute.
 */
export function awayNews(
  view: LabView,
  away: Away,
  gpu: number | null,
  disputed: ReadonlySet<string>,
): AwayNews {
  const left = Date.parse(away.since);
  const after = (at: string | null | undefined): boolean =>
    typeof at === 'string' && Date.parse(at) > left;
  const posts = view.posts.filter((post) => after(post.at));
  // A dispute comes first, then the most settled. A direction that ended comes last.
  const order: Record<Verdict, number> = {
    'holds-up': 1,
    'ruled-out': 3,
    leading: 4,
    open: 5,
  };
  const lines = view.directions
    .flatMap(({ direction }) => {
      const news = posts.filter(
        (post) => post.direction === direction.id && post.kind !== 'status',
      ).length;
      const opened = after(direction.openedAt);
      const ended = direction.state !== 'open' && after(direction.stoppedAt);
      const missed = view.checks.some(
        (check) =>
          check.direction === direction.id &&
          check.state === 'done' &&
          check.outcome !== 'holds' &&
          after(check.endedAt),
      );
      // A note of Verifold, such as a verdict, counts as news too.
      const noted = posts.some((post) => post.direction === direction.id);
      if (!noted && !opened && !ended) return [];
      const { verdict, evidence } = direction;
      const dispute = evidence !== null && disputed.has(evidence.post);
      // The agent's evidence goes in brackets, so its words keep their own case.
      const said = [
        verdict !== 'open' && evidence
          ? `${verdictText(verdict, dispute)} (${evidence.text.replace(/[.!?…]+$/u, '')}).`
          : opened
            ? `New. ${authorName(view, direction.openedBy)} opened it.`
            : 'Not settled yet.',
        missed ? 'A check did not hold.' : '',
        ended
          ? direction.state === 'stopped'
            ? 'You stopped it.'
            : 'Its agent closed it.'
          : '',
        news ? `${counted(news, 'new post')}.` : '',
      ]
        .filter(Boolean)
        .join(' ');
      // The mark is the row's: a direction that ended keeps its verdict's mark.
      const mark: AwayLine['mark'] = dispute
        ? 'disputed'
        : verdict === 'open' && opened && !ended
          ? 'new'
          : verdict;
      return [
        {
          rank: dispute
            ? 0
            : ended
              ? 7
              : missed
                ? 2
                : order[verdict] + (opened ? 1 : 0),
          line: {
            direction: direction.id,
            title: direction.title,
            mark,
            said,
          },
        },
      ];
    })
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.line);
  const finished = view.ledger.filter((run) => after(run.endedAt));
  const claude = Math.max(0, view.claudeUsd - away.spent.claude);
  const pods = Math.max(0, (gpu ?? 0) - away.spent.gpu);
  return {
    lines,
    posts: posts.filter((post) => post.kind !== 'status').length,
    runsEnded: finished.length,
    runsFailed: finished
      .filter((run) => run.status === 'failed' || run.status === 'timed-out')
      .map((run) => run.id),
    calls: view.state.calls.filter((call) => after(call.at)).length,
    // Money spent always shows, also when nothing else changed.
    cost:
      claude + pods >= 0.005
        ? `Spent since then: ≈${usd(claude + pods)} (Claude Code ≈${usd(claude)}${gpu === null ? '' : `, GPU ${usd(pods)}`}).`
        : '',
  };
}

/**
 * The counts of what came, such as "4 posts, 3 runs ended (1 failed: r-7),
 * 1 call for you", or "" when nothing came. `run` writes a failed run's ID,
 * as a link or as plain text.
 */
export function awayCounts(
  news: AwayNews,
  run: (id: string) => string,
): string {
  const failed = news.runsFailed;
  const links = failed.slice(0, awayRuns).map(run);
  if (failed.length > awayRuns) links.push(`${failed.length - awayRuns} more`);
  return [
    news.posts ? counted(news.posts, 'post') : '',
    news.runsEnded
      ? `${counted(news.runsEnded, 'run')} ended${failed.length ? ` (${failed.length} failed: ${links.join(', ')})` : ''}`
      : '',
    news.calls ? `${counted(news.calls, 'call')} for you` : '',
  ]
    .filter(Boolean)
    .join(', ');
}
