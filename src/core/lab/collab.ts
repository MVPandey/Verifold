/**
 * How the agents work together, from the records: open disagreements, what
 * objections changed, who needs whom, and the GPU queue. Pure functions, with
 * no lab. Verifold builds this. No agent and no Coordinator writes it, and
 * nothing here counts messages.
 */
import type { Post } from '../board.ts';
import { isOpen, type Lease } from '../leases.ts';
import type { RunRecord } from '../runs.ts';
import { openObjections } from './post-rules.ts';
import type { Call, Check, Direction, Thread } from './schema.ts';
import { openWaits, type Wait } from './waits.ts';
import { askers } from './words.ts';

/** A post that an objection stands against. */
export interface Disagreement {
  readonly post: Post;
  /** The objections that stand, oldest first. */
  readonly objections: readonly Post[];
  /** Its author answered an objection and did not accept it. */
  readonly answered: boolean;
  /** Its newest check. */
  readonly check: Check | null;
}

/** What objections did: how many came, from whom, and how many led to a change. */
export interface ObjectionCount {
  readonly total: number;
  /** Its target's author, or its own author, accepted it in an answer. */
  readonly accepted: number;
  /** No post replies to it, and no check took it. */
  readonly unanswered: number;
  /** Who raised them, most first. */
  readonly by: readonly { readonly author: string; readonly count: number }[];
}

/** A wait, and whether the one it waits on waits on the person. */
export interface Need extends Wait {
  readonly blocked: boolean;
}

/** The lab's runs on pods, and what stands in their way. */
export interface GpuQueue {
  readonly running: readonly RunRecord[];
  readonly queued: readonly RunRecord[];
  /** Pods that wait for the person. */
  readonly requested: readonly Lease[];
  /** The pods that exist now. */
  readonly pods: readonly Lease[];
  /** The newest stretch of at least `idleMinutes` with no run on a pod. */
  readonly idle: { readonly from: string; readonly to: string } | null;
}

export interface Collab {
  /** The newest objection first. */
  readonly disagreements: readonly Disagreement[];
  readonly objections: ObjectionCount;
  readonly needs: readonly Need[];
  readonly gpu: GpuQueue;
}

/** A shorter stretch between two pod runs is the time that a start takes. */
const idleMinutes = 10;

function objectionCount(
  posts: readonly Post[],
  checks: readonly Check[],
): ObjectionCount {
  const objections = posts.filter((post) => post.kind === 'objection');
  const accepted = new Set(
    posts.flatMap((post) =>
      post.kind === 'answer' && post.accepts && post.replyTo
        ? [post.replyTo]
        : [],
    ),
  );
  const replied = new Set(posts.flatMap((post) => post.replyTo ?? []));
  const taken = new Set(checks.flatMap((check) => check.objections));
  const counts = new Map<string, number>();
  for (const { author } of objections)
    counts.set(author, (counts.get(author) ?? 0) + 1);
  return {
    total: objections.length,
    accepted: objections.filter((post) => accepted.has(post.id)).length,
    unanswered: objections.filter(
      (post) => !replied.has(post.id) && !taken.has(post.id),
    ).length,
    by: [...counts]
      .map(([author, count]) => ({ author, count }))
      .sort((a, b) => b.count - a.count),
  };
}

function disagreements(
  posts: readonly Post[],
  checks: readonly Check[],
): readonly Disagreement[] {
  const byId = new Map(posts.map((post) => [post.id, post]));
  const standing = [...openObjections(posts, checks)].flatMap(
    ([id, objections]) => {
      const post = byId.get(id);
      return post
        ? [
            {
              post,
              objections,
              answered: posts.some(
                (entry) =>
                  entry.kind === 'answer' &&
                  entry.author === post.author &&
                  objections.some(({ id: asked }) => asked === entry.replyTo),
              ),
              check: checks.findLast((check) => check.claim === id) ?? null,
            },
          ]
        : [];
    },
  );
  const newest = (entry: Disagreement): number =>
    Date.parse(entry.objections.at(-1)?.at ?? entry.post.at);
  return standing.sort((a, b) => newest(b) - newest(a));
}

/** The newest stretch with no run on a pod, between two runs. */
function idleStretch(runs: readonly RunRecord[]): GpuQueue['idle'] {
  const started = runs
    .filter((run) => run.startedAt !== null)
    .sort(
      (a, b) => Date.parse(a.startedAt ?? '') - Date.parse(b.startedAt ?? ''),
    );
  let free: string | null = null;
  let idle: GpuQueue['idle'] = null;
  for (const run of started) {
    const from = free;
    const to = run.startedAt ?? '';
    if (from && Date.parse(to) - Date.parse(from) >= idleMinutes * 60_000)
      idle = { from, to };
    if (!run.endedAt) return idle;
    if (!free || Date.parse(run.endedAt) > Date.parse(free)) free = run.endedAt;
  }
  return idle;
}

function gpuQueue(
  runs: readonly RunRecord[],
  leases: readonly Lease[],
): GpuQueue {
  const onPods = runs.filter((run) => run.where !== 'local');
  return {
    running: onPods.filter((run) => run.status === 'running'),
    queued: onPods.filter((run) => run.status === 'queued'),
    requested: leases.filter((lease) => lease.state === 'requested'),
    pods: leases.filter(isOpen),
    idle: idleStretch(onPods),
  };
}

/** How the agents work together now. */
export function collabOf(records: {
  readonly posts: readonly Post[];
  readonly threads: readonly Thread[];
  readonly directions: readonly Pick<Direction, 'agent' | 'state'>[];
  readonly checks: readonly Check[];
  readonly calls: readonly Call[];
  readonly runs: readonly RunRecord[];
  /** The pods of the lab's directions. */
  readonly leases: readonly Lease[];
}): Collab {
  const { posts, threads, directions, calls, runs, leases } = records;
  const checks = records.checks.filter((check) => check.state !== 'dropped');
  const waits = openWaits(posts, threads, directions);
  const onPerson = new Set([
    ...waits.filter((wait) => wait.on === 'person').map((wait) => wait.waiter),
    ...calls.filter((call) => call.state === 'open').flatMap(askers),
  ]);
  return {
    disagreements: disagreements(posts, checks),
    objections: objectionCount(posts, checks),
    needs: waits.map((wait) => ({ ...wait, blocked: onPerson.has(wait.on) })),
    gpu: gpuQueue(runs, leases),
  };
}
