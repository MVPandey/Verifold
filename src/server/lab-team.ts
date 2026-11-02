/**
 * The pages of "How they work together", the reach line, and the idea map on
 * the wire. These shape records for one read, and hold no state.
 */
import { boardLimits, clip } from '../core/board.ts';
import type { ComputeView } from '../core/compute.ts';
import { collabOf } from '../core/lab/collab.ts';
import type { IdeaMapView } from '../core/lab/long-shots.ts';
import { mentionPattern } from '../core/lab/names.ts';
import {
  directionNamedIn,
  endedWhy,
  namedIn,
  reachOf,
} from '../core/lab/reach.ts';
import type { LabView, Thread as LabThread } from '../core/lab/schema.ts';
import type { RunRecord } from '../core/runs.ts';
import type {
  CollabPage,
  GpuRun,
  IdeaPage,
  Reach,
  ThreadRef,
} from '../protocol/api.ts';
import { waitItems } from './lab-threads.ts';

/** The most rows of each list on these pages. */
const pageLimits = {
  disagreements: 50,
  needs: 50,
  queue: 20,
  ideas: 300,
  sources: 300,
  draws: 20,
  /** Characters of a post's start. */
  text: 160,
  /** Characters of the `@` names of a reach. */
  named: 300,
};

/** Where the person's words go, as a read asks. */
export interface ReachQuery {
  readonly thread?: string;
  /** An agent ID or `all`. */
  readonly to?: string;
  readonly replyTo?: string;
  /** The `@` names of the text, as they stand in it. */
  readonly named?: string;
}

/** A read's query, or null when it is not valid. */
export function reachQuery(params: URLSearchParams): ReachQuery | null {
  const query: Record<string, string> = {};
  for (const [key, value] of params) {
    if (
      !['thread', 'to', 'replyTo', 'named'].includes(key) ||
      value.length > pageLimits.named
    )
      return null;
    query[key] = value;
  }
  return query;
}

/** Who the words of a query reach now. */
export function reachItem(view: LabView, query: ReachQuery): Reach {
  const ids = new Map(
    Object.entries(view.handles).map(([id, handle]) => [handle, id]),
  );
  const named = query.named ?? '';
  const mentions = [
    ...new Set([
      ...(query.to ? [query.to] : []),
      ...namedIn(named, mentionPattern(view.state)).flatMap((name) =>
        name === 'all' || name === 'person' ? [name] : (ids.get(name) ?? []),
      ),
    ]),
  ].slice(0, boardLimits.mentions);
  const direction = directionNamedIn(named, view.state.directions);
  return reachOf(
    { mentions, ...(direction ? { direction } : {}) },
    {
      target: query.replyTo
        ? view.posts.find((post) => post.id === query.replyTo)
        : undefined,
      thread: view.threads?.find((thread) => thread.id === query.thread),
    },
    {
      agents: view.directions.map(({ agent, direction: own, ...state }) => ({
        id: agent.id,
        handle: agent.handle,
        direction: own.id,
        status: state.status,
        until: state.until,
        parked: state.parked === true,
      })),
      paused: view.state.pausedAt ? (view.state.pausedFor ?? 'person') : null,
      slotsFull: view.slotsFull === true,
    },
  );
}

function threadRef(thread: LabThread | undefined): ThreadRef | null {
  return thread
    ? {
        id: thread.id,
        title: thread.title,
        ...(thread.plainTitle ? { plainTitle: thread.plainTitle } : {}),
        state: thread.state,
      }
    : null;
}

/** How the agents work together, from the records, within the page's limits. */
export function collabPage(
  view: LabView,
  compute: ComputeView | null,
): CollabPage {
  const threads = new Map(view.threads?.map((entry) => [entry.id, entry]));
  const handle = (id: string): string | null => view.handles[id] ?? null;
  const own = new Set(view.state.directions.map((entry) => entry.id));
  const collab = collabOf({
    posts: view.posts,
    threads: view.threads ?? [],
    directions: view.state.directions,
    checks: view.checks,
    calls: view.state.calls,
    runs: view.ledger,
    leases: (compute?.leases ?? []).filter(
      (lease) =>
        lease.directions?.some((id) => own.has(id)) &&
        Date.parse(lease.requestedAt) >= Date.parse(view.state.startedAt),
    ),
  });
  const waits = new Map(waitItems(view).map((wait) => [wait.post, wait]));
  const ended = new Map(
    view.directions.flatMap(({ agent, status }) => {
      const why = endedWhy(status);
      return why ? [[agent.id, why] as const] : [];
    }),
  );
  const gpuRun = (run: RunRecord): GpuRun => ({
    run: run.id,
    handle: handle(run.agent),
    since: run.startedAt ?? run.queuedAt,
  });
  const { gpu, objections } = collab;
  return {
    disagreements: collab.disagreements
      .slice(0, pageLimits.disagreements)
      .map(({ post, objections: standing, answered, check }) => ({
        post: post.id,
        author: post.author,
        handle: handle(post.author),
        thread: threadRef(threads.get(post.thread ?? '')),
        text: clip(post.text, pageLimits.text),
        objections: standing.map((entry) => ({
          post: entry.id,
          author: entry.author,
          handle: handle(entry.author),
        })),
        answered,
        check: check && {
          id: check.id,
          state: check.state,
          outcome: check.outcome,
          method: check.method,
        },
      })),
    objections: {
      ...objections,
      by: objections.by.map((entry) => ({
        ...entry,
        handle: handle(entry.author),
      })),
    },
    needs: collab.needs.slice(-pageLimits.needs).flatMap((need) => {
      const wait = waits.get(need.post);
      return wait
        ? [
            {
              ...wait,
              blocked: need.blocked,
              onEnded: ended.get(need.on) ?? null,
              plainSubject: threads.get(need.thread ?? '')?.plainTitle ?? null,
            },
          ]
        : [];
    }),
    gpu: {
      atOnce: compute ? compute.settings.maxRunningPods : null,
      running: gpu.running.slice(0, pageLimits.queue).map(gpuRun),
      queued: gpu.queued.slice(0, pageLimits.queue).map(gpuRun),
      requested: gpu.requested
        .slice(0, pageLimits.queue)
        .map((lease) => ({ lease: lease.id, at: lease.requestedAt })),
      pods: gpu.pods.slice(0, pageLimits.queue).map((lease) => lease.id),
      idle: gpu.idle,
    },
    handles: view.directions.map(({ agent }) => agent.handle),
  };
}

/** The idea map's page. Agents wrote its texts, and the page shows them as text. */
export function ideaPage(map: IdeaMapView): IdeaPage {
  // A draw that runs or waits on record has no judgment yet, and that is no failure.
  const going = map.drawing ? map.draws.at(-1) : undefined;
  return {
    ideas: map.ideas.slice(-pageLimits.ideas).map((idea) => ({
      id: idea.id,
      text: idea.text,
      tried: idea.tried,
      sources: idea.sources.length,
    })),
    ideaCount: map.ideas.length,
    sources: map.sources
      .slice(-pageLimits.sources)
      .map(({ id, title, url, date }) => ({ id, title, url, date })),
    sourceCount: map.sources.length,
    draws: map.draws
      .filter((draw) => draw !== going || draw.posted)
      .slice(-pageLimits.draws)
      .reverse()
      .map((draw) => ({
        at: draw.at,
        by: draw.by,
        judged: draw.posted !== undefined,
        shots: draw.posted ?? [],
      })),
    stopped: map.stopped,
    drawing: map.drawing,
    judge: map.judge,
  };
}
