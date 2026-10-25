import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import {
  liveOf,
  stepKind,
  toolStep,
  turnsOf,
  type ActivityTurn,
} from '../core/activity.ts';
import {
  agentId,
  boardLimits,
  clip,
  commitId,
  directionId,
  figureType,
  number,
  postId,
  proofRef,
  runId,
  type Artifact,
  type Post as BoardPost,
} from '../core/board.ts';
import {
  awayCounts,
  awayLines,
  awayNews,
  type Away as LabAway,
} from '../core/away.ts';
import { labGpu, settingsVersion, type ComputeView } from '../core/compute.ts';
import { validArchiveId } from '../core/archive.ts';
import {
  historyIndex,
  historyRun as readHistoryRun,
  historyTask as readHistoryTask,
  historyTaskDiff,
  historyTranscript,
  memoryFiles,
  ResearchRunWatch,
  type HistoryRunInfo,
  type LabHistory,
  type ResearchHistory,
  type ResultsView,
  type TaskView,
} from '../core/history.ts';
import { validTaskId } from '../core/team-records.ts';
import {
  isOpen,
  leaseLimits,
  maxCost,
  diskRate,
  spent,
  type Lease,
} from '../core/leases.ts';
import { commonGpus } from '../core/runpod.ts';
import { openDisputes } from '../core/disputes.ts';
import {
  askers,
  authorName,
  bringGroups,
  callWords,
  kindLabel,
} from '../core/lab/words.ts';
import { callLimits } from '../core/lab-tools.ts';
import type { HarnessName } from '../core/harness.ts';
import {
  labLimits,
  type BringList as LabBringList,
  type Brought,
  type Call as LabCall,
  type CallEffect,
  type Check as LabCheck,
  type Direction as LabDirection,
  type LabView,
} from '../core/lab/schema.ts';
import type { FigureRead } from '../core/lab.ts';
import type { PlanFact } from '../core/lab/schema.ts';
import { runSummary, type RunLogPart, type RunRecord } from '../core/runs.ts';
import { loadWorkspace } from '../core/storage.ts';
import {
  callSearchText,
  callState,
  searchLab,
  searchLimit,
  searchNote,
  searchWords,
  snippetParts,
} from '../core/search.ts';
import {
  SessionActionError,
  sessionTranscript,
  type SessionView,
} from '../core/session.ts';
import { TranscriptFile, type TranscriptEntry } from '../core/transcript.ts';
import {
  WorkspaceError,
  workspaceName,
  type ChangedFile,
} from '../core/workspaces.ts';
import {
  protocolVersion,
  searchQueryLimit,
  turnIdPattern,
  type ActionName,
  type Agent,
  type AgentStatus,
  type BoardPage,
  type BringGroup,
  type BringList,
  type BringRead,
  type Call,
  type CallOption,
  type CheckItem,
  type Direction,
  type DirectionCounts,
  type DirectionDiff,
  type Effect,
  type Fact,
  type FileDiff,
  type GpuType,
  type Lab,
  type LabList,
  type PodLease,
  type Post,
  type PostThread,
  type ProjectCompute,
  type Proof,
  type Run,
  type RunDetail,
  type SearchHit,
  type SearchResult,
  type Snapshot,
  type StartView,
  type Step,
  type Text,
  type Turn,
  type TurnPage,
  type Work,
  type HistoryEntry,
  type HistoryLabRun,
  type HistoryList,
  type HistoryResearchRun,
  type HistoryResults,
  type HistoryRun,
  type HistoryTask,
  type HistoryTurns,
} from '../protocol/api.ts';
import { figureHeaders, figurePixels, imageSize } from './figure.ts';
import { readJsonBody, record } from './http.ts';
import type { FirstRun } from './setup.ts';

/**
 * The desk API, version 1, under /api/v1/: a snapshot of what the screens
 * show, a stream that sends it again when it changes, pages of the board, of
 * an agent's turns, and of a turn's steps, a post's thread, the search, and
 * actions. The desk's host, origin, and token checks run before any of it.
 * See src/protocol/api.ts for the shapes.
 */

export const apiLimits = {
  /** Bytes of one snapshot. A bigger lab gets fewer items and characters. */
  snapshot: 512 * 1024,
  /** Posts in a snapshot, in one page of the board, and in one post's thread. */
  posts: 50,
  /** An agent's turns in a snapshot and in one page of turns. */
  turns: 20,
  /** Characters of an agent's message in a folded turn. */
  message: 2000,
  /** Bytes of a tool call's input, and of the end of its output, in a turn's steps. */
  toolText: 4 * 1024,
  /** Characters of a message, thought, request, or note in a turn's steps. */
  stepText: 16_000,
  /** Steps in one page of a turn. */
  steps: 200,
  /** Bytes of one page of steps. */
  stepPage: 256 * 1024,
  /** The most items of each list in a snapshot. */
  needsYou: 50,
  answered: 20,
  directions: 100,
  buildsOn: 10,
  agents: 50,
  disputes: 50,
  facts: 50,
  runs: 30,
  checks: 30,
  works: 20,
  /** Ended checks whose checkers show among the agents. */
  endedCheckers: 5,
  /** Characters of the question when the snapshot keeps nothing else. */
  question: 4000,
  /** Transcripts that a page read keeps, besides those of the agents in the snapshot. */
  extraTranscripts: 8,
  /** Open event streams at once. */
  streams: 4,
  /** Bytes that may wait for a slow stream. Past them the server drops the stream. */
  backlog: 8 * 1024 * 1024,
  /** Bytes of an action's body. */
  body: 512_000,
  /** Files in a bring-in list. */
  bringFiles: 2000,
  /** A direction's bring-ins in a bring-in read, the newest kept. */
  bringGroups: 20,
  /** Paths of one bring-in in a bring-in read. */
  bringPaths: 50,
  /** IDs in each list of the snapshot's `notify`, which no level cuts. */
  notify: 300,
  /** Bytes of the end of a run's log in a run read. */
  runLog: 64 * 1024,
  /** Kept files of a run in a run read. */
  runOutputs: 200,
  /** Files in a direction's diff read. */
  diffFiles: 2000,
  /** Bytes of a figure that a post cites. */
  figure: 20 * 1024 * 1024,
  /** Pods in the snapshot that are open, wait for the person, or carry a notice. */
  pods: 50,
  /** Earlier pods in the snapshot, the newest kept. */
  earlierPods: 20,
  /** GPU types in the snapshot. */
  gpuTypes: 60,
};

/** How many items of each list a snapshot keeps, and how much of each message. */
interface Level {
  readonly turns: number;
  /** 0 leaves the messages out. */
  readonly message: number;
  readonly posts: number;
  readonly needsYou: number;
  readonly answered: number;
  readonly directions: number;
  readonly buildsOn: number;
  readonly agents: number;
  readonly disputes: number;
  readonly facts: number;
  readonly runs: number;
  readonly checks: number;
  readonly works: number;
  /** It keeps the plan and the whole question. */
  readonly whole: boolean;
}

const full: Level = {
  turns: apiLimits.turns,
  message: apiLimits.message,
  posts: apiLimits.posts,
  needsYou: apiLimits.needsYou,
  answered: apiLimits.answered,
  directions: apiLimits.directions,
  buildsOn: apiLimits.buildsOn,
  agents: apiLimits.agents,
  disputes: apiLimits.disputes,
  facts: apiLimits.facts,
  runs: apiLimits.runs,
  checks: apiLimits.checks,
  works: apiLimits.works,
  whole: true,
};

/**
 * A snapshot uses the first level that fits `apiLimits.snapshot`. The last
 * level keeps no list, no plan, a cut question, and of the sign-off only its
 * time and line, so it always fits.
 */
const levels: readonly [Level, ...Level[]] = [
  full,
  { ...full, turns: 5, message: 500, answered: 10, runs: 20, checks: 20 },
  {
    ...full,
    turns: 3,
    message: 0,
    posts: 20,
    needsYou: 20,
    answered: 5,
    directions: 30,
    buildsOn: 3,
    agents: 20,
    disputes: 20,
    facts: 20,
    runs: 10,
    checks: 10,
    works: 5,
  },
  {
    turns: 0,
    message: 0,
    posts: 5,
    needsYou: 5,
    answered: 0,
    directions: 10,
    buildsOn: 0,
    agents: 10,
    disputes: 5,
    facts: 5,
    runs: 0,
    checks: 0,
    works: 0,
    whole: true,
  },
  {
    turns: 0,
    message: 0,
    posts: 0,
    needsYou: 0,
    answered: 0,
    directions: 0,
    buildsOn: 0,
    agents: 0,
    disputes: 0,
    facts: 0,
    runs: 0,
    checks: 0,
    works: 0,
    whole: false,
  },
];

/** Where the API reads from: the desk's current project, lab, and pods. */
export interface ApiSources {
  /** The project folder. Null before setup made it. */
  readonly root: string | null;
  readonly lab: { view(): LabView | null } | undefined;
  readonly compute: { view(): ComputeView } | undefined;
  /** A session in a worker slot, or null. */
  readonly session: (id: string) => SessionView | null;
  readonly works: readonly Work[];
  /** When the person left the lab, and the two costs then. */
  readonly away: () => Promise<LabAway | null>;
  /** The desk's bring-in reads, when it runs a lab. */
  readonly bring?: BringSource | undefined;
  /** Why the project's lab did not start, when its start failed. */
  readonly startProblem?: (() => string | null) | undefined;
  /** "Agents at once" of the project, when this process runs its worker slots. */
  readonly agentsAtOnce?: (() => number | null) | undefined;
  /** The slow pod actions that run in the background, and the ones that failed there. */
  readonly computeWorks?: (() => readonly Work[]) | undefined;
  /** The lab's reads that the snapshot keeps folded: a run's log, and a direction's diff. */
  readonly reads?: LabReadSource | undefined;
}

/** The lab's own reads of a run and of a direction's diff, which the desk's panels use too. */
export interface LabReadSource {
  /**
   * A run's record, the handle of its agent, and whether this process runs
   * the lab's agents, without the whole lab view. Null for a run that the
   * lab does not have.
   */
  readonly run: (run: string) => {
    readonly record: RunRecord;
    readonly handle: string | null;
    readonly here: boolean;
  } | null;
  /** The end of a run's log, at most `bytes`, or null when the run has none. */
  readonly runLog: (run: string, bytes: number) => Promise<RunLogPart | null>;
  /**
   * What a direction changed since its start, or the diff that `proof`
   * cites, with the diff of `file` when it is one of its files. Null for a
   * direction or a proof that the lab does not have. It throws a
   * SessionActionError when the file is not in the diff.
   */
  readonly diff: (
    direction: string,
    file: string | undefined,
    proof: string | undefined,
  ) => Promise<{
    readonly from: string;
    readonly to: string;
    readonly files: readonly ChangedFile[];
    readonly diff: { readonly text: string; readonly cut: boolean } | null;
  } | null>;
  /** The figure that a post cites, such as p-12.0, as the post pinned it, up to `bytes`, or why there is none. */
  readonly figure: (proof: string, bytes: number) => Promise<FigureRead>;
}

/** The desk's own bring-in reads, which its bring-in panel uses too. */
export interface BringSource {
  /**
   * The files that a bring-in of a direction can copy, at the commit that
   * the person looked at. Null before a look. A string when Verifold could
   * not read the files.
   */
  readonly list: (direction: string) => Promise<LabBringList | string | null>;
  /**
   * One file's diff at the commit of a bring-in, or null. It throws a
   * SessionActionError when the file is not in the bring-in.
   */
  readonly diff: (
    direction: string,
    file: string,
    commit: string,
  ) => Promise<{
    readonly text: string;
    readonly cut: boolean;
    readonly to: string;
  } | null>;
}

/** A direction's agent or a checker, as the lab records it. */
interface AgentRef {
  readonly id: string;
  readonly handle: string;
  readonly harness: HarnessName;
  readonly session: string | null;
  readonly status: AgentStatus;
  readonly until: string | null;
  readonly model: string | null;
  readonly direction: string | null;
  readonly check: string | null;
  readonly spend: number | null;
}

/** What one snapshot needs, read once: the lab, its pods, and each agent's turns. */
interface Loaded {
  readonly view: LabView;
  readonly agents: readonly AgentRef[];
  readonly compute: ComputeView | null;
  /** The lab's GPU spend and limit. Null without pods to read. */
  readonly gpu: ReturnType<typeof labGpu> | null;
  readonly disputes: ReturnType<typeof openDisputes>;
  readonly works: readonly Work[];
  readonly away: Lab['away'];
  readonly turns: ReadonlyMap<string, readonly ActivityTurn[]>;
  /** The model that each agent's harness reported, by agent ID. */
  readonly models: ReadonlyMap<string, string>;
  /** The model that each agent's session asked for, by agent ID, such as one that Verifold picked for Codex. */
  readonly requested: ReadonlyMap<string, string>;
}

/** A transcript file that the API follows, with its turns as of `key`. */
interface Followed {
  readonly file: TranscriptFile;
  key: string;
  turns: readonly ActivityTurn[];
}

const cents = (usd: number): number => Math.round(usd * 100) / 100;

/** A text of at most `max` characters. */
function text(value: string, max: number): Text {
  return { text: clip(value, max), trimmed: value.length > max };
}

/** True for the second and later bytes of a UTF-8 character. */
const inside = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0xc0) === 0x80;

/** The first `max` bytes of a text, cut between characters. */
function head(value: string, max: number): Text {
  const bytes = Buffer.from(value);
  if (bytes.length <= max) return { text: value, trimmed: false };
  let end = max;
  while (end > 0 && inside(bytes[end])) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), trimmed: true };
}

/** The last `max` bytes of a text, cut between characters. */
function tail(value: string, max: number): Text {
  const bytes = Buffer.from(value);
  if (bytes.length <= max) return { text: value, trimmed: false };
  let start = bytes.length - max;
  while (start < bytes.length && inside(bytes[start])) start++;
  return { text: bytes.subarray(start).toString('utf8'), trimmed: true };
}

function directionAgent(entry: LabView['directions'][number]): AgentRef {
  return {
    id: entry.agent.id,
    handle: entry.agent.handle,
    harness: entry.agent.host,
    session: entry.agent.session,
    status: entry.status,
    until: entry.until,
    model: entry.agent.model,
    direction: entry.direction.id,
    check: null,
    spend: entry.agent.spend?.usd ?? null,
  };
}

function checkAgent(check: LabCheck): AgentRef {
  return {
    id: check.agent,
    handle: check.handle,
    harness: check.harness,
    session: check.session,
    status: check.state,
    until: null,
    model: check.model,
    direction: null,
    check: check.id,
    spend: check.spend?.usd ?? null,
  };
}

/** The agents of a snapshot: each direction's agent, then the checkers that wait or run and the newest that ended. */
function shownAgents(view: LabView): AgentRef[] {
  const going = (check: LabCheck): boolean =>
    check.state === 'queued' || check.state === 'running';
  const ended = new Set(
    view.checks
      .filter((check) => !going(check))
      .slice(-apiLimits.endedCheckers),
  );
  return [
    ...view.directions.map(directionAgent),
    ...view.checks
      .filter((check) => going(check) || ended.has(check))
      .map(checkAgent),
  ];
}

/** Any agent of the lab: a direction's agent or any checker. */
function anyAgent(view: LabView, id: string): AgentRef | null {
  const direction = view.directions.find((entry) => entry.agent.id === id);
  if (direction) return directionAgent(direction);
  const check = view.checks.findLast((entry) => entry.agent === id);
  return check ? checkAgent(check) : null;
}

/** A turn runs while its agent works and no later turn started. */
const working = (agent: AgentRef): boolean =>
  agent.status === 'working' || agent.status === 'running';

/**
 * The lab's posts and runs by the harness call that made them. A post's key
 * is `agent:generation:call`, and a run's key is `generation:call`, so the
 * call's ID is what follows the agent and the generation.
 */
interface ProofIndex {
  readonly posts: ReadonlyMap<string, readonly BoardPost[]>;
  readonly runs: ReadonlyMap<string, readonly RunRecord[]>;
  readonly allPosts: readonly BoardPost[];
  readonly ledger: readonly RunRecord[];
}

function group<T>(
  items: readonly T[],
  call: (item: T) => string | null,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const id = call(item);
    if (id) map.set(id, [...(map.get(id) ?? []), item]);
  }
  return map;
}

function proofIndex(view: LabView): ProofIndex {
  return {
    posts: group(
      view.posts,
      (post) => post.key?.split(':').slice(2).join(':') || null,
    ),
    runs: group(
      view.ledger,
      (run) => run.key.split(':').slice(1).join(':') || null,
    ),
    allPosts: view.posts,
    ledger: view.ledger,
  };
}

/** The most posts and runs that a folded turn names. */
const turnProofs = 20;

/**
 * The posts and runs that a turn's tool calls made, by the calls' IDs. When
 * a call that posts or starts a run matched no record, as when a harness
 * names its calls in a way that the records do not carry, the agent's posts
 * and runs from while the turn ran fill in, matched by time and marked so.
 */
function turnProof(
  entry: ActivityTurn,
  agent: string,
  index: ProofIndex,
): Pick<Turn, 'posts' | 'runs' | 'proofByTime'> {
  const posts = new Set<string>();
  const runs = new Set<string>();
  let unmatched = false;
  for (const call of entry.entries) {
    if (call.kind !== 'tool') continue;
    // A transcript ID is the run's prefix, a dot, then the harness's own call ID.
    const id = call.id.slice(call.id.indexOf('.') + 1);
    const made = (index.posts.get(id) ?? []).filter(
      (post) => post.author === agent,
    );
    const started = (index.runs.get(id) ?? []).filter(
      (run) => run.agent === agent,
    );
    for (const post of made) posts.add(post.id);
    for (const run of started) runs.add(run.id);
    const kind = stepKind(call.name ?? '');
    if (
      (kind === 'post' || kind === 'run') &&
      call.status === 'done' &&
      !made.length &&
      !started.length
    )
      unmatched = true;
  }
  let byTime = false;
  if (unmatched) {
    // Fallback: matched by time, not by call. See `Turn.proofByTime`.
    const from = Date.parse(entry.startedAt);
    const to = Date.parse(entry.lastAt);
    const during = (at: string): boolean => {
      const time = Date.parse(at);
      return time >= from && time <= to;
    };
    for (const post of index.allPosts)
      if (post.author === agent && during(post.at) && !posts.has(post.id)) {
        posts.add(post.id);
        byTime = true;
      }
    for (const run of index.ledger)
      if (run.agent === agent && during(run.queuedAt) && !runs.has(run.id)) {
        runs.add(run.id);
        byTime = true;
      }
  }
  return {
    posts: [...posts].slice(0, turnProofs),
    runs: [...runs].slice(0, turnProofs),
    proofByTime: byTime,
  };
}

function foldTurn(
  entry: ActivityTurn,
  agent: AgentRef,
  running: boolean,
  message: number,
  index: ProofIndex,
): Turn {
  return {
    id: entry.id,
    startedAt: entry.startedAt,
    endedAt: running ? null : entry.lastAt,
    rev: entry.entries.reduce((max, item) => Math.max(max, item.seq), 0),
    counts: entry.counts,
    message:
      message && entry.message !== null ? text(entry.message, message) : null,
    ...turnProof(entry, agent.id, index),
  };
}

/** The page of turns that ends before index `end`, or the newest page. */
function pageOfTurns(
  agent: AgentRef,
  turns: readonly ActivityTurn[],
  size: number,
  message: number,
  index: ProofIndex,
  end = turns.length,
): TurnPage {
  const start = Math.max(0, end - size);
  const newest = turns.at(-1);
  return {
    turns: turns
      .slice(start, end)
      .map((entry) =>
        foldTurn(
          entry,
          agent,
          working(agent) && entry === newest,
          message,
          index,
        ),
      ),
    more: start > 0,
  };
}

/** `stored`: the pod secrets that this computer stores, or null when Compute is not known. */
function effect(value: CallEffect, stored: ReadonlySet<string> | null): Effect {
  switch (value.type) {
    case 'pod':
      return {
        type: 'pod',
        gpu: value.gpuType,
        hours: value.hours,
        secrets: value.secrets.length,
        missing: stored
          ? value.secrets.filter((name) => !stored.has(name)).length
          : null,
        ...(stored
          ? {
              missingNames: value.secrets.filter((name) => !stored.has(name)),
            }
          : {}),
      };
    case 'hours':
      return { type: 'hours', hours: value.hours };
    case 'open':
      return {
        type: 'open',
        title: value.title,
        harness: value.harness,
        bar: value.bar,
      };
    case 'stop':
      return { type: 'stop', direction: value.direction };
    case 'domains':
      return { type: 'domains', domains: [...value.domains] };
  }
}

function call(
  entry: LabCall,
  handle: (agent: string) => string,
  stored: ReadonlySet<string> | null,
): Call {
  const options: CallOption[] = entry.options.map((option) => ({
    label: option.label,
    ...(option.detail ? { detail: option.detail } : {}),
    usd: option.usd,
    minutes: option.minutes,
    effect: option.effect ? effect(option.effect, stored) : null,
  }));
  return {
    id: entry.id,
    at: entry.at,
    kind: entry.kind,
    question: entry.question,
    why: entry.why,
    // The first asker's direction and why are the call's own. A later asker keeps its own.
    askers: askers(entry).map((agent) => {
      const joined = entry.joined.find((asker) => asker.agent === agent);
      return {
        agent,
        handle: handle(agent),
        direction: joined ? joined.direction : entry.direction,
        why: joined ? joined.why : entry.why,
      };
    }),
    byVerifold: entry.by === 'verifold',
    options,
    pick: entry.pick,
    undoMinutes: entry.undoMinutes,
    wordsLimit: callLimits.words,
    // Saved, and its option not applied yet: what the lab's recovery also
    // finds unfinished after a stop, which then gets a note.
    applying:
      entry.state === 'answered' &&
      entry.answer !== null &&
      Boolean(entry.options[entry.answer.option]?.effect) &&
      entry.applied === null &&
      entry.note === null,
    state: entry.state,
    answer: entry.answer
      ? { option: entry.answer.option, at: entry.answer.at }
      : null,
    words: entry.words,
    undoUntil: entry.undoUntil,
    note: entry.note,
    post: entry.post,
    ...(entry.facts?.length ? { facts: entry.facts.map(fact) } : {}),
  };
}

/** A fact of a plan or a call, as the API sends it. */
function fact(entry: PlanFact): Fact {
  return {
    claim: entry.claim,
    source: entry.source,
    sourceDate: entry.sourceDate,
    listedAt: entry.checkedAt,
  };
}

/** Each direction's bring-ins: how many files came in, and when the newest did. */
function broughtByDirection(
  brought: readonly Brought[],
): Map<string, { readonly files: number; readonly lastAt: string }> {
  const counts = new Map<string, { files: number; lastAt: string }>();
  for (const entry of brought) {
    const known = counts.get(entry.direction);
    if (!known) counts.set(entry.direction, { files: 1, lastAt: entry.at });
    else {
      known.files++;
      if (entry.at > known.lastAt) known.lastAt = entry.at;
    }
  }
  return counts;
}

/** The lab's directions that hold up and that are ruled out, from one scan that the counts and the notify lists share. */
interface Settled {
  readonly holdsUp: readonly LabDirection[];
  readonly ruledOut: readonly LabDirection[];
}

/** The lab's directions counted over all of them. Still open: open, with no verdict or a disputed one. */
function directionCounts(
  directions: readonly LabDirection[],
  settled: Settled,
  disputed: (entry: LabDirection) => boolean,
): DirectionCounts {
  return {
    total: directions.length,
    holdsUp: settled.holdsUp.length,
    ruledOut: settled.ruledOut.length,
    open: directions.filter(
      (entry) =>
        entry.state === 'open' && (entry.verdict === 'open' || disputed(entry)),
    ).length,
  };
}

function direction(
  entry: LabDirection,
  disputed: (entry: LabDirection) => boolean,
  buildsOn: readonly LabDirection['buildsOn'][number][],
  brought: { readonly files: number; readonly lastAt: string } | undefined,
): Direction {
  return {
    id: entry.id,
    title: entry.title,
    bar: entry.bar,
    runs: entry.runs,
    noise: entry.noise,
    buildsOn: buildsOn.map((work) => ({ text: work.text, known: work.known })),
    state: entry.state,
    verdict: entry.verdict,
    disputed: disputed(entry),
    evidence: entry.evidence
      ? {
          text: entry.evidence.text,
          post: entry.evidence.post,
          run: entry.evidence.run,
        }
      : null,
    agent: entry.agent,
    openedBy: entry.openedBy,
    openedAt: entry.openedAt,
    stoppedAt: entry.stoppedAt,
    head: entry.head,
    brought: brought ?? null,
  };
}

function proof(artifact: Artifact): Proof {
  switch (artifact.type) {
    case 'run':
      return { type: 'run', run: artifact.run };
    case 'diff':
      return {
        type: 'diff',
        direction: artifact.direction ?? null,
        from: artifact.from,
        to: artifact.to,
        paths: [...artifact.paths],
      };
    case 'file':
    case 'figure':
      return {
        type: artifact.type,
        direction: artifact.direction ?? null,
        path: artifact.path,
        commit: artifact.commit,
        bytes: artifact.bytes,
      };
  }
}

function post(entry: BoardPost, handle: (agent: string) => string): Post {
  const agent = entry.author !== 'person' && entry.author !== 'verifold';
  return {
    id: entry.id,
    at: entry.at,
    author: entry.author,
    handle: agent ? handle(entry.author) : null,
    harness: entry.harness ?? null,
    kind: entry.kind,
    direction: entry.direction ?? null,
    text: entry.text,
    replyTo: entry.replyTo ?? null,
    mentions: [...entry.mentions],
    proof: entry.artifacts.map(proof),
  };
}

/**
 * The time away, with the news since then in the words of the desk's Home
 * (core/away.ts): the first directions with news, how many more, what came,
 * and what the lab spent. `gpu`: the GPU spend, or null without pods to read.
 */
function awayOf(
  view: LabView,
  away: LabAway,
  gpu: number | null,
  disputes: Loaded['disputes'],
): NonNullable<Lab['away']> {
  const news = awayNews(
    view,
    away,
    gpu,
    new Set(disputes.map((dispute) => dispute.target.id)),
  );
  return {
    since: away.since,
    spentThen: {
      plansUsd: cents(away.spent.claude),
      gpuUsd: cents(away.spent.gpu),
    },
    news: {
      lines: news.lines.slice(0, awayLines),
      moreLines: Math.max(0, news.lines.length - awayLines),
      counts: awayCounts(news, (id) => id),
      cost: news.cost,
    },
  };
}

/** The page of posts before post number `before`, or the newest page. Oldest first. */
function boardPage(
  posts: readonly BoardPost[],
  size: number,
  handle: (agent: string) => string,
  before?: number,
): BoardPage {
  const older =
    before === undefined
      ? posts
      : posts.filter((entry) => number(entry.id) < before);
  const shown = size ? older.slice(-size) : [];
  return {
    posts: shown.map((entry) => post(entry, handle)),
    more: older.length > shown.length,
  };
}

function run(entry: RunRecord): Run {
  return {
    id: entry.id,
    agent: entry.agent,
    direction: entry.direction,
    status: entry.status,
    command: entry.command,
    why: entry.why,
    where:
      entry.where === 'local'
        ? 'local'
        : { pod: entry.where.pod, gpu: entry.where.gpu },
    commit: entry.commit,
    exitCode: entry.exitCode,
    queuedAt: entry.queuedAt,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    metrics: entry.metrics,
    note: entry.note,
  };
}

/** History's bounds of texts and lists, under the core's own bounds. */
const historyBounds = {
  long: 4000,
  short: 1000,
  message: 1000,
  answer: 500,
  result: 300,
  command: 200,
  commands: 20,
  actions: 100,
  sources: 20,
  attempts: 20,
  versions: 20,
  files: 200,
  brief: 16_000,
  memory: 64 * 1024,
  /** A title, a name, a direction, or a piece of evidence. */
  name: 300,
  personas: 10,
  candidates: 20,
  checks: 50,
  claims: 50,
  evidence: 20,
  risk: 10,
} as const;

/** How many items of `items` a list of at most `max` leaves out. */
function over(items: readonly unknown[], max: number): number {
  return Math.max(0, items.length - max);
}

function historyEntry(info: HistoryRunInfo): HistoryEntry {
  return {
    id: info.id,
    kind: info.kind,
    at: info.at,
    question: info.question && clip(info.question, apiLimits.question),
    direction: info.direction && clip(info.direction, historyBounds.name),
    bytes: info.bytes,
    tasks: info.tasks,
  };
}

/**
 * A lab's archived run: its plan, directions, runs, and newest posts. Without
 * a readable record of the lab, its runs and posts only.
 */
function historyLab(found: LabHistory): HistoryLabRun {
  const handle = (agent: string): string =>
    found.agents.get(agent)?.handle ?? agent;
  const state = found.state;
  const plan = state?.plan ?? null;
  return {
    kind: 'lab',
    entry: historyEntry(found.info),
    readable: state !== null,
    question: state?.question ?? null,
    startedAt: state?.startedAt ?? null,
    plan: plan
      ? {
          reading: text(plan.reading, historyBounds.long),
          cost: text(plan.cost, historyBounds.short),
          facts: plan.facts.map(fact),
        }
      : null,
    directions: (state?.directions ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      bar: entry.bar,
      state: entry.state,
      verdict: entry.verdict,
      evidence: entry.evidence
        ? clip(entry.evidence.text, historyBounds.short)
        : null,
      handle: found.agents.get(entry.agent)?.handle ?? null,
    })),
    runs: found.runs.map(run),
    posts: found.posts.map((entry) => post(entry, handle)),
    olderPosts: found.postCount - found.posts.length,
  };
}

/** A direction's results: each list within its bound, and a check or claim that cannot be read as null. */
function historyResults(results: ResultsView): HistoryResults {
  const answer = results.answer;
  return {
    direction: clip(results.direction, historyBounds.name),
    checks: results.checks.slice(0, historyBounds.checks).map((check) =>
      check === null
        ? null
        : {
            check: check.check,
            result: check.result,
            value: clip(check.value, historyBounds.short),
            reason: text(check.reason, historyBounds.short),
            ruling: check.ruling
              ? {
                  result: check.ruling.result,
                  reason: clip(check.ruling.reason, historyBounds.short),
                }
              : null,
          },
    ),
    moreChecks: over(results.checks, historyBounds.checks),
    answer: answer
      ? {
          statement:
            answer.statement === null
              ? null
              : text(answer.statement, historyBounds.long),
          claims: answer.claims.slice(0, historyBounds.claims).map((claim) =>
            claim === null
              ? null
              : {
                  text: clip(claim.text, historyBounds.short),
                  evidence: claim.evidence
                    .slice(0, historyBounds.evidence)
                    .map((item) => clip(item, historyBounds.name)),
                  moreEvidence: over(claim.evidence, historyBounds.evidence),
                },
          ),
          moreClaims: over(answer.claims, historyBounds.claims),
          decision: answer.decision
            ? {
                kind: answer.decision.kind,
                note:
                  answer.decision.note === null
                    ? null
                    : clip(answer.decision.note, historyBounds.short),
              }
            : null,
        }
      : null,
  };
}

/**
 * A research-flow run: its question and brief, research, directions, the
 * coordinator, task summaries, messages, results, the person's sessions,
 * and pods. Each list keeps its bound and says how many it leaves out.
 */
function historyResearch(found: ResearchHistory): HistoryResearchRun {
  const workspace = found.workspace;
  const research = workspace?.research;
  const coordinator = found.coordinator;
  const actions = coordinator?.actions.slice(-historyBounds.actions) ?? [];
  const candidates = workspace?.candidates ?? [];
  return {
    kind: 'research',
    entry: historyEntry(found.info),
    question: research?.topic ?? found.info.question,
    brief: workspace?.context
      ? text(workspace.context, historyBounds.brief)
      : null,
    plan: research?.plan
      ? {
          scope: clip(research.plan.scope, historyBounds.long),
          personas: research.plan.personas
            .slice(0, historyBounds.personas)
            .map((persona) => ({
              name: clip(persona.name, historyBounds.name),
              task: clip(persona.task, historyBounds.short),
            })),
          morePersonas: over(research.plan.personas, historyBounds.personas),
        }
      : null,
    attempts: found.attempts.slice(0, historyBounds.attempts).map((attempt) => {
      const sources = attempt.report?.sources ?? [];
      return {
        id: attempt.id,
        phase: attempt.record?.phase ?? null,
        status: attempt.record?.status ?? null,
        harness: attempt.record?.host ?? null,
        model: attempt.record?.model ?? null,
        startedAt: attempt.record?.startedAt ?? null,
        finishedAt: attempt.record?.finishedAt ?? null,
        summary: attempt.report
          ? text(attempt.report.summary, historyBounds.long)
          : null,
        delegation: attempt.report
          ? text(attempt.report.delegation, historyBounds.short)
          : null,
        sources: sources.slice(0, historyBounds.sources).map((source) => ({
          title: clip(source.title, historyBounds.name),
          url: source.url,
        })),
        moreSources: over(sources, historyBounds.sources),
        transcript: attempt.transcript,
      };
    }),
    moreAttempts:
      found.moreAttempts + over(found.attempts, historyBounds.attempts),
    candidates: candidates
      .slice(0, historyBounds.candidates)
      .map((candidate) => {
        const sources = candidate.sources ?? [];
        return {
          id: candidate.id,
          title: clip(candidate.title, historyBounds.name),
          recommendation: text(candidate.recommendation, historyBounds.short),
          checks: candidate.gates
            .slice(0, historyBounds.checks)
            .map((check) => clip(check, historyBounds.short)),
          moreChecks: over(candidate.gates, historyBounds.checks),
          sources: sources.slice(0, historyBounds.sources),
          moreSources: over(sources, historyBounds.sources),
          kind: candidate.kind ?? null,
        };
      }),
    moreCandidates: over(candidates, historyBounds.candidates),
    chosen: workspace?.selectedId ?? null,
    coordinator: coordinator
      ? {
          objective: text(coordinator.objective, historyBounds.long),
          harness: coordinator.host,
          model: coordinator.model,
          startedAt: coordinator.startedAt,
          stoppedAt: coordinator.stoppedAt,
          planApproved: coordinator.planApproved,
          session: coordinator.session,
          actions: actions.map((action) =>
            action === null
              ? null
              : {
                  at: action.at,
                  tool: clip(action.tool, historyBounds.name),
                  reason:
                    action.reason === null
                      ? null
                      : clip(action.reason, historyBounds.short),
                  ok: action.ok,
                  result: text(action.result, historyBounds.result),
                },
          ),
          olderActions: coordinator.actions.length - actions.length,
        }
      : null,
    tasks: found.tasks.map((task) => ({
      id: task.id,
      record: task.record,
      title: task.title === null ? null : clip(task.title, historyBounds.name),
      state: task.state,
      harness: task.host,
      model: task.model,
      attempts: task.attempts,
      versions: task.versions,
      outcome: task.outcome,
    })),
    moreTasks: found.moreTasks,
    messages: found.messages.map((message) => ({
      id: message.id,
      at: message.at,
      from: clip(message.from, historyBounds.name),
      to: clip(message.to, historyBounds.name),
      kind: message.kind,
      text: text(message.text, historyBounds.message),
      status: message.status,
      answer:
        message.answer === null
          ? null
          : text(message.answer, historyBounds.answer),
    })),
    olderMessages: found.messageCount - found.messages.length,
    results: found.results.map(historyResults),
    moreResults: found.moreResults,
    sessions: found.sessions.map(({ record, transcript }) => {
      const commands = record.commands.slice(-historyBounds.commands);
      return {
        id: record.id,
        harness: record.host,
        model: record.model,
        mode: record.mode,
        status: record.status,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        costUsd: record.costUsd,
        commands: commands.map((command) => ({
          at: command.at,
          tool: command.tool,
          action: text(command.action, historyBounds.command),
          risk: command.risk.slice(0, historyBounds.risk),
        })),
        olderCommands: record.commands.length - commands.length,
        transcript,
      };
    }),
    pods: found.pods.map((pod) => ({
      lease: pod.lease,
      gpu: clip(pod.gpu, historyBounds.name),
      state: clip(pod.state, historyBounds.name),
      tasks: pod.tasks.slice(0, historyBounds.evidence),
      requestedAt: pod.requestedAt,
      costUsd: pod.costUsd === null ? null : cents(pod.costUsd),
    })),
    morePods: found.morePods,
  };
}

/** A task of a research-flow run in full: its newest attempts, with their newest versions and files. */
function historyTaskOf(task: TaskView): HistoryTask {
  const attempts = task.attempts.slice(-historyBounds.attempts);
  return {
    id: task.id,
    title: clip(task.title, historyBounds.name),
    objective: text(task.objective, historyBounds.long),
    state: task.state,
    harness: task.host,
    model: task.model,
    revision: task.revision,
    olderAttempts: task.attempts.length - attempts.length,
    attempts: attempts.map((attempt) => {
      const versions = attempt.versions.slice(-historyBounds.versions);
      return {
        number: attempt.number,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        outcome: attempt.outcome,
        note:
          attempt.note === null
            ? null
            : clip(attempt.note, historyBounds.short),
        session: attempt.session,
        versions: versions.map((version) => ({
          number: version.number,
          at: version.at,
          turn: version.turn,
          files: version.files.slice(0, historyBounds.files),
          moreFiles: over(version.files, historyBounds.files),
          reply:
            version.reply === null
              ? null
              : text(version.reply, historyBounds.answer),
          decision: version.decision
            ? {
                kind: version.decision.kind,
                note:
                  version.decision.note === null
                    ? null
                    : clip(version.decision.note, historyBounds.short),
                by: version.decision.by,
              }
            : null,
        })),
        olderVersions: attempt.versions.length - versions.length,
      };
    }),
  };
}

function check(entry: LabCheck): CheckItem {
  return {
    id: entry.id,
    post: entry.claim,
    direction: entry.direction,
    run: entry.run,
    harness: entry.harness,
    agent: entry.agent,
    handle: entry.handle,
    sameHarness: entry.sameHarness,
    blind: entry.blind,
    state: entry.state,
    outcome: entry.outcome,
    method: entry.method,
    result: entry.result,
    note: entry.note,
    queuedAt: entry.queuedAt,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
  };
}

/** A pod as the screens show it: no pod name, ID, or address, and secret names only. */
function podLease(
  lease: Lease,
  stored: ReadonlySet<string>,
  closing: Readonly<Record<string, 'stopping' | 'ending'>>,
  now: number,
): PodLease {
  const secrets = lease.secrets ?? [];
  // Records from before `noticeAt` give the time of their last change.
  const noticeAt = lease.notice
    ? (lease.noticeAt ?? lease.history.at(-1)?.at ?? null)
    : null;
  return {
    id: lease.id,
    state: lease.state,
    ...(closing[lease.id] ? { closing: closing[lease.id] } : {}),
    gpu: lease.gpu,
    asker: lease.requestedBy,
    directions: lease.directions ?? [],
    reason: text(lease.reason, leaseLimits.reason),
    rateUsd: cents(lease.rate + diskRate(lease.diskGb)),
    hours: lease.hours,
    maxUsd: cents(maxCost(lease.rate, lease.diskGb, lease.hours)),
    spentUsd: cents(spent(lease, now)),
    requestedAt: lease.requestedAt,
    endsAt: lease.deadline,
    idleMinutes:
      lease.state === 'ready' && lease.activeAt
        ? Math.max(0, Math.floor((now - Date.parse(lease.activeAt)) / 60_000))
        : null,
    ended: lease.end ? { at: lease.end.at, reason: lease.end.reason } : null,
    notice: lease.notice,
    noticeAt,
    secrets,
    missingSecrets: secrets.filter((name) => !stored.has(name)),
  };
}

const stockOf = {
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;

/**
 * RunPod's GPUs for the settings page: each type that RunPod offers, the
 * dearest first, then each allowed type that it does not offer now, so a
 * save keeps it. A cut list keeps every allowed type.
 */
function gpuTypes(view: ComputeView): ProjectCompute['gpus'] {
  if (!view.gpus || !view.gpusAt) return null;
  const offered = new Set(view.gpus.map((gpu) => gpu.id));
  const allowed = new Set(view.settings.gpuTypes);
  const types: GpuType[] = [
    ...[...view.gpus]
      .sort((a, b) => b.price - a.price)
      .map((gpu) => ({
        id: gpu.id,
        name: gpu.name,
        memoryGb: gpu.memoryGb,
        usdPerHour: gpu.price,
        stock: gpu.stock ? stockOf[gpu.stock] : null,
        common: commonGpus.includes(gpu.id),
      })),
    ...[...allowed]
      .filter((id) => !offered.has(id))
      .map((id) => ({
        id,
        name: id,
        memoryGb: 0,
        usdPerHour: null,
        stock: null,
        common: false,
      })),
  ];
  let room =
    apiLimits.gpuTypes - types.filter((gpu) => allowed.has(gpu.id)).length;
  return {
    at: view.gpusAt,
    types: types.filter((gpu) => allowed.has(gpu.id) || room-- > 0),
  };
}

/** The project's pods and their settings, as the settings page and Needs you show them. No key, no secret value. */
function shapeCompute(
  view: ComputeView,
  agentsAtOnce: number | null,
  works: readonly Work[],
  now: number,
): ProjectCompute {
  const stored = new Set(view.secrets.map((secret) => secret.name));
  const closing = view.closing ?? {};
  const current: Lease[] = [];
  const earlier: Lease[] = [];
  for (const lease of [...view.leases].reverse())
    (isOpen(lease) || lease.state === 'requested' || lease.notice
      ? current
      : earlier
    ).push(lease);
  const { settings, budget, month } = view;
  return {
    keyStored: view.key
      ? { last4: view.key.last4, problem: view.key.problem ?? null }
      : null,
    settings: {
      limitUsd: settings.limitUsd,
      maxUsdPerHour: settings.maxUsdPerHour,
      maxHoursPerLease: settings.maxHoursPerLease,
      idleMinutes: settings.idleMinutes,
      maxRunningPods: settings.maxRunningPods,
      gpuTypes: settings.gpuTypes,
      images: settings.images,
      diskGb: settings.diskGb,
      askBeforePod: settings.askBeforePod,
    },
    settingsVersion: settingsVersion(settings),
    agentsAtOnce,
    budget: {
      spentUsd: cents(budget.spent),
      heldUsd: cents(budget.reserved),
      leftUsd: budget.left === null ? null : cents(Math.max(0, budget.left)),
      rateUsd: cents(budget.rate),
    },
    month: month
      ? {
          spentUsd: cents(month.spentUsd),
          limitUsd: month.limitUsd,
          leftUsd: cents(month.leftUsd),
        }
      : null,
    pods: current
      .slice(0, apiLimits.pods)
      .map((lease) => podLease(lease, stored, closing, now)),
    earlier: earlier
      .slice(0, apiLimits.earlierPods)
      .map((lease) => podLease(lease, stored, closing, now)),
    earlierCount: earlier.length,
    gpus: gpuTypes(view),
    problem: view.problem,
    // The newest, as the lab's works.
    works: works.slice(-apiLimits.works).map((work) => ({
      action: work.action,
      label: work.label,
      at: work.at,
      error: work.error,
      ...(work.lease === undefined ? {} : { lease: work.lease }),
    })),
  };
}

/** The lab as the screens show it, within one level. */
function shapeLab(loaded: Loaded, level: Level): Lab {
  const { view, disputes } = loaded;
  const { state } = view;
  const proof = proofIndex(view);
  const omitted: Partial<Record<LabList, number>> = {};
  /** The first `max` items, or with `newest` the last ones. The rest count as omitted. */
  const keep = <T>(
    list: readonly T[],
    max: number,
    name: LabList,
    newest = false,
  ): T[] => {
    if (list.length <= max) return [...list];
    omitted[name] = (omitted[name] ?? 0) + list.length - max;
    if (!max) return [];
    return newest ? list.slice(-max) : list.slice(0, max);
  };
  const handle = (agent: string): string => view.handles[agent] ?? agent;
  const disputed = (entry: LabDirection): boolean =>
    disputes.some(
      ({ target }) =>
        target.direction === entry.id || target.id === entry.evidence?.post,
    );
  const gpu = loaded.gpu ?? { spent: 0, limit: null };
  const stored = loaded.compute
    ? new Set(loaded.compute.secrets.map((secret) => secret.name))
    : null;
  const waiting = (entry: LabCall): boolean =>
    entry.state === 'open' || entry.state === 'undoing';
  const settled: Settled = {
    holdsUp: state.directions.filter((entry) => entry.verdict === 'holds-up'),
    ruledOut: state.directions.filter((entry) => entry.verdict === 'ruled-out'),
  };
  const newest = (list: readonly { readonly id: string }[]): string[] =>
    list.slice(-apiLimits.notify).map((entry) => entry.id);
  const agents: Agent[] = keep(loaded.agents, level.agents, 'agents').map(
    (ref) => {
      const turns = loaded.turns.get(ref.id) ?? [];
      const asked =
        state.calls
          .filter((entry) => waiting(entry) && askers(entry).includes(ref.id))
          .map((entry) => entry.at)
          .sort()[0] ?? null;
      return {
        id: ref.id,
        handle: ref.handle,
        harness: ref.harness,
        model: loaded.models.get(ref.id) ?? ref.model,
        requestedModel: ref.model ?? loaded.requested.get(ref.id) ?? null,
        direction: ref.direction,
        check: ref.check,
        status: ref.status,
        until: ref.until,
        live: liveOf({
          status: ref.status,
          harness: ref.harness,
          turn: turns.at(-1) ?? null,
          asked,
        }),
        turns: pageOfTurns(ref, turns, level.turns, level.message, proof),
        spendUsd: ref.spend,
      };
    },
  );
  const plan = state.plan;
  if (plan && !level.whole) omitted.plan = 1;
  const brought = broughtByDirection(state.brought);
  const directions = keep(state.directions, level.directions, 'directions');
  const kept = new Set(directions.map((entry) => entry.id));
  return {
    question: level.whole
      ? state.question
      : clip(state.question, apiLimits.question),
    postLimit: boardLimits.personText,
    signoffLimit: labLimits.signoff,
    startedAt: state.startedAt,
    agentsHere: view.runs,
    paused: state.pausedAt
      ? { at: state.pausedAt, reason: state.pausedFor ?? 'person' }
      : null,
    budget: state.budget
      ? { hours: state.budget.hours, deadline: state.budget.deadline }
      : null,
    money: {
      plansUsd: cents(view.claudeUsd),
      gpuUsd: cents(gpu.spent),
      gpuLimitUsd: gpu.limit,
      ...(loaded.compute?.month
        ? {
            month: {
              spentUsd: cents(loaded.compute.month.spentUsd),
              limitUsd: loaded.compute.month.limitUsd,
            },
          }
        : {}),
    },
    // The calls that waited longest come first.
    needsYou: keep(state.calls.filter(waiting), level.needsYou, 'needsYou').map(
      (entry) => call(entry, handle, stored),
    ),
    answered: keep(
      state.calls.filter((entry) => !waiting(entry)),
      level.answered,
      'answered',
      true,
    )
      .reverse()
      .map((entry) => call(entry, handle, stored)),
    directions: directions.map((entry) =>
      direction(
        entry,
        disputed,
        keep(entry.buildsOn, level.buildsOn, 'buildsOn'),
        brought.get(entry.id),
      ),
    ),
    directionCounts: directionCounts(state.directions, settled, disputed),
    agents,
    planner: state.opener,
    plannerStarting: view.openingPlanner === true,
    plan:
      plan && level.whole
        ? {
            post: plan.post,
            at: plan.at,
            reading: plan.reading,
            cost: plan.cost,
            directions: [...plan.directions],
            facts: keep(plan.facts, level.facts, 'facts').map(fact),
            // The facts are those of an earlier plan: this one listed none, or the same ones.
            ...(plan.factsPost !== undefined && plan.factsPost !== plan.post
              ? { factsCarried: true }
              : {}),
            ...(plan.version === undefined ? {} : { version: plan.version }),
            previous: plan.previous ?? null,
            changed: plan.changed ?? null,
          }
        : null,
    board: boardPage(view.posts, level.posts, handle),
    disputes: keep(disputes, level.disputes, 'disputes').map((entry) => ({
      post: entry.target.id,
      objections: entry.objections.map((objection) => objection.id),
      check: entry.check?.id ?? null,
    })),
    runs: keep(view.ledger, level.runs, 'runs', true).map(run),
    checks: keep(view.checks, level.checks, 'checks', true).map(check),
    // A sign-off is small, so every level keeps it: the answer never looks unsigned.
    signoff: state.signoff
      ? {
          at: state.signoff.at,
          note: state.signoff.note,
          directions: state.signoff.directions
            .filter((entry) => kept.has(entry.id))
            .map((entry) => ({
              id: entry.id,
              verdict: entry.verdict,
              commit: entry.commit,
              check: entry.check,
            })),
        }
      : null,
    works: keep(loaded.works, level.works, 'works', true).map((work) => ({
      action: work.action,
      label: work.label,
      at: work.at,
      error: work.error,
      ...(work.call === undefined ? {} : { call: work.call }),
      ...(work.option === undefined ? {} : { option: work.option }),
      ...(work.direction === undefined ? {} : { direction: work.direction }),
    })),
    away: loaded.away,
    omitted,
    notify: {
      calls: newest(state.calls.filter(waiting)),
      holdsUp: newest(settled.holdsUp),
      ruledOut: newest(settled.ruledOut),
    },
  };
}

/** What a step that is not a tool call is, in plain words. */
const stepWords: Readonly<
  Record<Exclude<TranscriptEntry['kind'], 'tool'>, string>
> = {
  request: 'Message to the agent',
  text: 'Message',
  thinking: 'Thinking',
  note: 'Note',
};

/** A transcript entry as a step of a turn. */
function step(entry: TranscriptEntry, index: number): Step {
  const tool = entry.kind === 'tool';
  return {
    index,
    id: entry.id,
    parent: entry.parent,
    type: entry.kind,
    kind: tool ? stepKind(entry.name ?? '') : null,
    words:
      entry.kind === 'tool'
        ? toolStep(entry.name ?? '', entry.title ?? '')
        : stepWords[entry.kind],
    title: entry.title ?? null,
    status: entry.status ?? null,
    at: entry.at,
    endedAt:
      tool && entry.status !== 'running' ? (entry.updatedAt ?? null) : null,
    input: tool && entry.input ? head(entry.input, apiLimits.toolText) : null,
    output:
      tool && entry.output ? tail(entry.output, apiLimits.toolText) : null,
    text:
      !tool && entry.text !== undefined
        ? text(entry.text, apiLimits.stepText)
        : null,
  };
}

/** Two signals are equal when every part is the same value or the same object. */
function same(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

/** A bring-in list as the API sends it, within its bound. */
function bringList(list: LabBringList, branch: string): BringList {
  const files = list.files.slice(0, apiLimits.bringFiles);
  const left = list.left.slice(0, apiLimits.bringFiles);
  return {
    direction: list.direction,
    branch,
    commit: list.commit,
    working: list.working,
    newer: list.newer,
    left: left.map((file) => ({ path: file.path, why: file.why })),
    leftOmitted: list.left.length - left.length,
    files: files.map((file) => ({
      path: file.path,
      change: file.change,
      bytes: file.bytes,
      ticked: file.ticked,
      out: file.out,
      why: file.why,
      since: file.since,
      code: file.code,
    })),
    omitted: list.files.length - files.length,
  };
}

/** A direction's newest bring-ins, oldest first, within their bounds. */
function bringHistory(
  brought: readonly Brought[],
  direction: string,
): BringGroup[] {
  return bringGroups(brought, direction)
    .slice(-apiLimits.bringGroups)
    .map((group) => ({
      at: group.at,
      commit: group.commit,
      paths: group.paths.slice(0, apiLimits.bringPaths),
      more: Math.max(0, group.paths.length - apiLimits.bringPaths),
    }));
}

/**
 * Reads what the API sends: the lab's records and each agent's transcript.
 * It follows the transcripts of the snapshot's agents, and a few that a page
 * read asked for, and reads only their new lines. It groups a transcript into
 * turns again only when the transcript changed.
 */
export class ApiReader {
  private readonly sources: () => ApiSources;
  private readonly files = new Map<string, Followed>();
  /** Transcripts that page reads asked for, the newest last. */
  private readonly extra: string[] = [];
  /** Whether the current run is from the research flow, read again only after its records change. */
  private readonly researchRun = new ResearchRunWatch();

  constructor(sources: () => ApiSources) {
    this.sources = sources;
  }

  /** A session's transcript, read up to its end. Null without a session. */
  private async follow(
    root: string,
    session: string | null,
  ): Promise<Followed | null> {
    const path = session ? sessionTranscript(root, session) : null;
    if (!path) return null;
    let followed = this.files.get(path);
    if (!followed) {
      followed = { file: new TranscriptFile(path), key: '', turns: [] };
      this.files.set(path, followed);
    }
    await followed.file.refreshAll();
    return followed;
  }

  /** The turns of a followed transcript. They are grouped again only after the file changed. */
  private turnsOf(followed: Followed | null): readonly ActivityTurn[] {
    if (!followed) return [];
    const key = `${followed.file.log.epoch}:${followed.file.log.last}`;
    if (followed.key !== key) {
      followed.turns = turnsOf(followed.file.log.list());
      followed.key = key;
    }
    return followed.turns;
  }

  /** Stop following transcripts that no snapshot agent and no recent page read needs. */
  private prune(root: string, agents: readonly AgentRef[]): void {
    const keep = new Set(this.extra);
    for (const agent of agents) {
      const path = agent.session
        ? sessionTranscript(root, agent.session)
        : null;
      if (path) keep.add(path);
    }
    for (const path of this.files.keys())
      if (!keep.has(path)) this.files.delete(path);
  }

  /**
   * Cheap fingerprints of everything that a snapshot shows: the lab's state
   * and records by reference, each direction's status, the newest post, the
   * runs, the money in cents, the transcripts' update counts, and the away
   * digest. An equal signal means an equal snapshot, so nothing is built.
   */
  async signal(): Promise<readonly unknown[]> {
    const sources = this.sources();
    const view = sources.lab?.view() ?? null;
    const parts: unknown[] = [
      sources.root,
      view?.state,
      view?.runs,
      view?.claudeUsd,
      sources.works,
    ];
    const root = sources.root;
    // A project without a lab shows its question, why its lab did not start, and a run of the research flow.
    if (!view && root)
      parts.push(sources.startProblem?.(), await this.researchRun.read(root));
    // The pods and their settings show with or without a lab. A stored pod secret changes what a pod lacks.
    const compute = root ? sources.compute?.view() : undefined;
    if (compute)
      parts.push(
        compute.settings,
        compute.leases,
        compute.key,
        compute.gpusAt,
        compute.problem,
        compute.secrets.map((secret) => secret.name).join('\n'),
        cents(compute.budget.spent),
        cents(compute.budget.reserved),
        compute.month ? cents(compute.month.spentUsd) : null,
        compute.month?.limitUsd,
        sources.agentsAtOnce?.(),
        sources.computeWorks?.(),
      );
    if (!view || !root) return parts;
    parts.push(view.posts.length, view.posts.at(-1), ...view.ledger);
    for (const entry of view.directions)
      parts.push(entry.agent, entry.status, entry.until);
    if (compute) parts.push(cents(labGpu(compute, view.state.startedAt).spent));
    const agents = shownAgents(view);
    const followed = await Promise.all(
      agents.map((agent) => this.follow(root, agent.session)),
    );
    for (const [index, agent] of agents.entries())
      parts.push(
        followed[index]?.file.log.epoch,
        followed[index]?.file.log.last,
        agent.session
          ? sources.session(agent.session)?.record.reportedModel
          : undefined,
        agent.session
          ? sources.session(agent.session)?.record.model
          : undefined,
      );
    this.prune(root, agents);
    if (view.runs) {
      const away = await sources.away();
      parts.push(away?.since, away?.spent.claude, away?.spent.gpu);
    }
    return parts;
  }

  private async load(): Promise<Loaded | null> {
    const sources = this.sources();
    const view = sources.lab?.view() ?? null;
    const root = sources.root;
    if (!view || !root) return null;
    const agents = shownAgents(view);
    const followed = await Promise.all(
      agents.map((agent) => this.follow(root, agent.session)),
    );
    const turns = new Map<string, readonly ActivityTurn[]>();
    const models = new Map<string, string>();
    const requested = new Map<string, string>();
    for (const [index, agent] of agents.entries()) {
      turns.set(agent.id, this.turnsOf(followed[index] ?? null));
      const session = agent.session
        ? sources.session(agent.session)?.record
        : undefined;
      if (session?.reportedModel) models.set(agent.id, session.reportedModel);
      if (session?.model) requested.set(agent.id, session.model);
    }
    const away = view.runs ? await sources.away() : null;
    const compute = sources.compute?.view() ?? null;
    const gpu = compute ? labGpu(compute, view.state.startedAt) : null;
    const disputes = openDisputes(view);
    return {
      view,
      agents,
      compute,
      gpu,
      disputes,
      works: sources.works,
      away: away ? awayOf(view, away, gpu?.spent ?? null, disputes) : null,
      turns,
      models,
      requested,
    };
  }

  /** `GET /api/v1/history`: the project's runs and its memory files. Null without a project. */
  async history(): Promise<HistoryList | null> {
    const root = this.sources().root;
    if (!root) return null;
    const index = await historyIndex(root);
    return {
      current: index.current ? historyEntry(index.current) : null,
      runs: index.runs.map(historyEntry),
      more: index.more,
      memory: (await memoryFiles(root)).map((file) => {
        const shown = head(file.text, historyBounds.memory);
        return {
          name: file.name,
          text: { text: shown.text, trimmed: file.cut || shown.trimmed },
        };
      }),
    };
  }

  /** `GET /api/v1/history/:id`: one run, or null when the project has no such run. */
  async historyRun(id: string): Promise<HistoryRun | null> {
    const root = this.sources().root;
    const found = root ? await readHistoryRun(root, id) : null;
    if (!found) return null;
    return found.kind === 'lab' ? historyLab(found) : historyResearch(found);
  }

  /** `GET /api/v1/history/:id/tasks/:task`: one task of a run in full, or null. */
  async historyTask(id: string, task: string): Promise<HistoryTask | null> {
    const root = this.sources().root;
    const found = root ? await readHistoryTask(root, id, task) : null;
    return found ? historyTaskOf(found) : null;
  }

  /** `GET /api/v1/history/:id/turns?source=`: the newest turns of a transcript in a run, folded. */
  async historyTurns(id: string, source: string): Promise<HistoryTurns | null> {
    const root = this.sources().root;
    const path = root ? await historyTranscript(root, id, source) : null;
    if (!path) return null;
    const file = new TranscriptFile(path);
    await file.refreshAll();
    const turns = turnsOf(file.log.list());
    const shown = turns.slice(-apiLimits.turns);
    return {
      turns: shown.map((entry) => ({
        id: entry.id,
        startedAt: entry.startedAt,
        endedAt: entry.lastAt,
        rev: entry.entries.reduce((max, item) => Math.max(max, item.seq), 0),
        counts: entry.counts,
        message:
          entry.message === null
            ? null
            : text(entry.message, apiLimits.message),
      })),
      more: turns.length > shown.length,
    };
  }

  /** `GET /api/v1/history/:id/tasks/:task/diff`: one file of a task version, or null. */
  async historyDiff(
    id: string,
    task: string,
    version: number,
    file: string,
  ): Promise<FileDiff | null> {
    const root = this.sources().root;
    const shown = root
      ? await historyTaskDiff(root, id, task, version, file)
      : null;
    return shown
      ? { text: shown.text, trimmed: shown.cut, commit: shown.commit }
      : null;
  }

  /**
   * The snapshot without its version, epoch, rev, and time: its data, and
   * the data's JSON within the size bound. The JSON is all that the feed
   * measures, compares, and sends, so the snapshot is serialized once.
   */
  async build(): Promise<SnapshotBody> {
    const sources = this.sources();
    const root = sources.root;
    const project = root ? basename(root) : '';
    // The project's pods, the same at every level: their own lists have bounds.
    const view = root ? sources.compute?.view() : undefined;
    const compute = view
      ? {
          compute: shapeCompute(
            view,
            sources.agentsAtOnce?.() ?? null,
            sources.computeWorks?.() ?? [],
            Date.now(),
          ),
        }
      : {};
    const loaded = await this.load();
    if (!loaded) {
      // A project without a lab: its question, so the page can start the lab, and why the last start failed.
      const question = root
        ? ((await loadWorkspace(root).catch(() => null))?.research?.topic ??
          null)
        : null;
      const data: SnapshotData = {
        project,
        lab: null,
        trimmed: false,
        ...(root
          ? {
              question: question && clip(question, apiLimits.question),
              startProblem: sources.startProblem?.() ?? null,
              researchRun: await this.researchRun.read(root),
            }
          : {}),
        ...compute,
      };
      return { data, json: JSON.stringify(data) };
    }
    // The feed adds the version, the epoch, the rev, and the time.
    const room = apiLimits.snapshot - 256;
    const shaped = (level: Level, smaller: boolean): SnapshotBody => {
      const lab = shapeLab(loaded, level);
      const data: SnapshotData = {
        project,
        lab,
        ...compute,
        trimmed: smaller || Object.keys(lab.omitted).length > 0,
      };
      return { data, json: JSON.stringify(data) };
    };
    // The first level that fits, else the last.
    const [first, ...smaller] = levels;
    let built = shaped(first, false);
    for (const level of smaller) {
      if (Buffer.byteLength(built.json) <= room) break;
      built = shaped(level, true);
    }
    return built;
  }

  /** The posts before post number `before`, or the newest posts. Null without a lab. */
  board(before?: number): BoardPage | null {
    const view = this.sources().lab?.view();
    if (!view) return null;
    return boardPage(
      view.posts,
      apiLimits.posts,
      (agent) => view.handles[agent] ?? agent,
      before,
    );
  }

  /**
   * A post and the replies below it at any depth, oldest first, as the lab's
   * agents read a thread: at most `apiLimits.posts` posts. Null without a
   * lab, or when the lab has no such post.
   */
  thread(id: string): PostThread | null {
    const view = this.sources().lab?.view();
    const root = view?.posts.find((entry) => entry.id === id);
    if (!view || !root) return null;
    // A reply always comes after the post that it answers, so one pass finds every depth.
    const below = new Set([root.id]);
    const replies: BoardPost[] = [];
    for (const entry of view.posts)
      if (entry.replyTo && below.has(entry.replyTo)) {
        below.add(entry.id);
        replies.push(entry);
      }
    const room = apiLimits.posts - 1;
    const handle = (agent: string): string => view.handles[agent] ?? agent;
    return {
      posts: [root, ...replies.slice(0, room)].map((entry) =>
        post(entry, handle),
      ),
      more: replies.length > room,
    };
  }

  /**
   * The lab's search (core/search.ts), as the desk's panel runs it: the
   * newest hits with their marked snippets. A call hit carries its question
   * and answer, so a page that does not hold the call can still show it.
   * Null without a lab.
   */
  search(q: string): SearchResult | null {
    const view = this.sources().lab?.view();
    if (!view) return null;
    const words = searchWords(q);
    const found = words ? searchLab(view, words) : [];
    const hits = !words
      ? []
      : found.slice(0, searchLimit).map((entry): SearchHit => {
          if ('post' in entry) {
            const { post } = entry;
            return {
              type: 'post',
              id: post.id,
              at: post.at,
              kind: post.kind,
              label: kindLabel(post),
              author: authorName(view, post.author),
              direction: post.direction ?? null,
              snippet: snippetParts(post.text, words.any),
            };
          }
          if ('run' in entry) {
            const { run, at } = entry;
            return {
              type: 'run',
              id: run.id,
              at,
              author: authorName(view, run.agent),
              direction: run.direction,
              summary: runSummary(run),
              snippet: snippetParts(run.command, words.any),
            };
          }
          const { call } = entry;
          const chosen = call.answer
            ? call.options[call.answer.option]?.label
            : undefined;
          return {
            type: 'call',
            id: call.id,
            at: call.at,
            label: callWords[call.kind],
            author: authorName(view, call.by),
            state: call.state,
            summary: callState(call),
            question: call.question,
            // Words on Verifold's own open call go to the lab, and only an option answers it.
            answer:
              call.answer && chosen !== undefined
                ? { option: chosen, at: call.answer.at }
                : call.words !== null && call.state !== 'open'
                  ? { words: call.words }
                  : null,
            note: call.note,
            snippet: snippetParts(callSearchText(call), words.any),
          };
        });
    return {
      q,
      note: searchNote(words, found.length),
      total: found.length,
      hits,
    };
  }

  /** Any agent of the lab, with its turns and the lab's view. Null when the lab has no such agent. */
  private async agent(id: string): Promise<{
    readonly agent: AgentRef;
    readonly turns: readonly ActivityTurn[];
    readonly view: LabView;
  } | null> {
    const sources = this.sources();
    const view = sources.lab?.view();
    const root = sources.root;
    if (!view || !root) return null;
    const agent = anyAgent(view, id);
    if (!agent) return null;
    const followed = await this.follow(root, agent.session);
    // A transcript that only a page read needs stays for the next few reads.
    const path = agent.session ? sessionTranscript(root, agent.session) : null;
    if (path) {
      const at = this.extra.indexOf(path);
      if (at >= 0) this.extra.splice(at, 1);
      this.extra.push(path);
      this.extra.splice(0, this.extra.length - apiLimits.extraTranscripts);
    }
    return { agent, turns: this.turnsOf(followed), view };
  }

  /** A page of an agent's turns, before the turn `before` or the newest. Null: no such agent or turn. */
  async turnPage(id: string, before?: string): Promise<TurnPage | null> {
    const found = await this.agent(id);
    if (!found) return null;
    const end =
      before === undefined
        ? found.turns.length
        : found.turns.findIndex((entry) => entry.id === before);
    if (end < 0) return null;
    return pageOfTurns(
      found.agent,
      found.turns,
      apiLimits.turns,
      apiLimits.message,
      proofIndex(found.view),
      end,
    );
  }

  /**
   * One turn with a page of its steps, as JSON: the newest steps, or those
   * before index `before`. A page holds at most `limit` steps (at most
   * `apiLimits.steps`) and about `apiLimits.stepPage` bytes, and always at
   * least one step when there is one. With `tools`, only tool calls count.
   * Null: no such agent, turn, or step.
   */
  async turn(
    id: string,
    turnId: string,
    before?: number,
    page: { readonly limit?: number; readonly tools?: boolean } = {},
  ): Promise<string | null> {
    const found = await this.agent(id);
    const entry = found?.turns.find((item) => item.id === turnId);
    if (!found || !entry) return null;
    const end = before ?? entry.entries.length;
    if (end > entry.entries.length) return null;
    const limit = Math.min(page.limit ?? apiLimits.steps, apiLimits.steps);
    const counted = (item: TranscriptEntry): boolean =>
      !page.tools || item.kind === 'tool';
    const steps: string[] = [];
    let bytes = 0;
    let start = end;
    while (start > 0 && steps.length < limit) {
      const item = entry.entries[start - 1];
      if (!item) break;
      if (!counted(item)) {
        start--;
        continue;
      }
      const json = JSON.stringify(step(item, start - 1));
      const size = Buffer.byteLength(json);
      if (steps.length && bytes + size > apiLimits.stepPage) break;
      steps.unshift(json);
      bytes += size;
      start--;
    }
    const more = entry.entries.slice(0, start).some(counted);
    const shown = foldTurn(
      entry,
      found.agent,
      working(found.agent) && entry === found.turns.at(-1),
      apiLimits.message,
      proofIndex(found.view),
    );
    return `{"turn":${JSON.stringify(shown)},"steps":[${steps.join(',')}],"more":${more}}`;
  }

  /**
   * What a bring-in of a direction can copy, and its bring-ins so far. Null
   * without a lab, or for a direction that the lab does not have.
   */
  async bring(id: string): Promise<BringRead | null> {
    const sources = this.sources();
    const view = sources.lab?.view();
    const entry = view?.state.directions.find((item) => item.id === id);
    if (!view || !entry) return null;
    const read = sources.bring ? await sources.bring.list(id) : null;
    return {
      list:
        read && typeof read === 'object'
          ? bringList(read, workspaceName(entry.workspace))
          : null,
      error: typeof read === 'string' ? read : null,
      history: bringHistory(view.state.brought, id),
    };
  }

  /**
   * One file's diff at the commit of a bring-in, or null when there is none.
   * A SessionActionError says why the file is not in the bring-in.
   */
  async bringDiff(
    id: string,
    file: string,
    commit: string,
  ): Promise<FileDiff | null> {
    const source = this.sources().bring;
    const shown = source ? await source.diff(id, file, commit) : null;
    return shown
      ? { text: shown.text, trimmed: shown.cut, commit: shown.to }
      : null;
  }

  /** A run in full, with its kept files and the end of its log. Null for a run that the lab does not have. */
  async run(id: string): Promise<RunDetail | null> {
    const reads = this.sources().reads;
    const found = reads?.run(id);
    if (!reads || !found) return null;
    const { record: entry, handle, here } = found;
    const log = await reads.runLog(id, apiLimits.runLog);
    return {
      run: run(entry),
      handle,
      harness: entry.harness,
      minutes: entry.minutes,
      outputs: entry.outputs
        .slice(0, apiLimits.runOutputs)
        .map((output) => ({ path: output.path, bytes: output.bytes })),
      moreOutputs: Math.max(0, entry.outputs.length - apiLimits.runOutputs),
      log,
      cancelable:
        here && (entry.status === 'queued' || entry.status === 'running'),
    };
  }

  /**
   * What a direction changed since its start, or the diff that `proof`
   * cites, with one file's diff when `file` names one of its files. Null for
   * a direction or a proof that the lab does not have. A SessionActionError
   * says why a file is not in the diff.
   */
  async directionDiff(
    id: string,
    file?: string,
    proof?: string,
  ): Promise<DirectionDiff | null> {
    const shown = await this.sources().reads?.diff(id, file, proof);
    if (!shown) return null;
    return {
      from: shown.from,
      to: shown.to,
      files: shown.files
        .slice(0, apiLimits.diffFiles)
        .map(({ path, change, regular }) => ({ path, change, regular })),
      moreFiles: Math.max(0, shown.files.length - apiLimits.diffFiles),
      diff:
        shown.diff && file !== undefined
          ? { path: file, text: shown.diff.text, trimmed: shown.diff.cut }
          : null,
    };
  }

  /** The figure that a post cites, such as p-12.0, or why there is none. Null without a lab. */
  async figure(proof: string): Promise<FigureRead | null> {
    return (
      (await this.sources().reads?.figure(proof, apiLimits.figure)) ?? null
    );
  }
}

/** A snapshot without the fields that the feed sets. */
type SnapshotData = Omit<Snapshot, 'protocolVersion' | 'epoch' | 'rev' | 'at'>;

/** A snapshot's data, and the data's JSON. */
export interface SnapshotBody {
  readonly data: SnapshotData;
  readonly json: string;
}

/** The newest snapshot: its rev, its JSON as the API sends it, and its project and lab. */
interface Latest {
  readonly rev: number;
  readonly text: string;
  /** What a terminal's screen reads. The feed keeps no more of the data. */
  readonly data: Pick<Snapshot, 'project' | 'lab'>;
}

/**
 * The snapshot and its stream. At each tick the feed reads cheap signals of
 * the lab. Only when one moved does it build the snapshot, and only when the
 * data changed does the rev grow and the watchers get it. An idle lab costs a
 * signal read per tick and no build.
 */
export class ApiFeed {
  /** A new ID for each start of Verifold. Clients compare (epoch, rev). */
  readonly epoch = randomBytes(8).toString('hex');
  private readonly reader: ApiReader;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private rev = 0;
  /** The JSON of the data of the newest snapshot. */
  private body: string | null = null;
  private signal: readonly unknown[] | null = null;
  private latest: Latest | null = null;
  private building: Promise<Latest> | null = null;
  private built = 0;
  /** Each watcher, such as an event stream or a terminal's view, with the rev that it got last. */
  private readonly watchers = new Map<Watcher, number>();
  /** The open event streams, for their limit and their heartbeat. */
  private readonly streams = new Set<ServerResponse>();
  private poll: NodeJS.Timeout | undefined;
  private beat: NodeJS.Timeout | undefined;

  constructor(
    reader: ApiReader,
    timing: { readonly pollMs?: number; readonly heartbeatMs?: number } = {},
  ) {
    this.reader = reader;
    this.pollMs = timing.pollMs ?? 1000;
    this.heartbeatMs = timing.heartbeatMs ?? 15_000;
  }

  /** How many snapshots the feed built. */
  get builds(): number {
    return this.built;
  }

  /** The newest snapshot, with its rev. Calls at the same time share one read. */
  current(): Promise<Latest> {
    this.building ??= this.refresh().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async refresh(): Promise<Latest> {
    const signal = await this.reader.signal();
    if (this.latest && this.signal && same(signal, this.signal))
      return this.latest;
    const { data, json } = await this.reader.build();
    this.built += 1;
    this.signal = signal;
    if (this.latest && json === this.body) return this.latest;
    this.body = json;
    this.rev += 1;
    // The data's JSON goes in as it is, after the fields that the feed sets.
    this.latest = {
      rev: this.rev,
      text: `{"protocolVersion":${protocolVersion},"epoch":"${this.epoch}","rev":${this.rev},"at":"${new Date().toISOString()}",${json.slice(1)}`,
      data: { project: data.project, lab: data.lab },
    };
    return this.latest;
  }

  /**
   * Write to a stream. A stream that cannot keep up, or whose write fails,
   * closes, and its close drops its watcher.
   */
  private write(stream: ServerResponse, chunk: string): void {
    if (stream.writableLength <= apiLimits.backlog)
      try {
        if (stream.writable) stream.write(chunk);
        return;
      } catch {
        // The stream closes, as one that cannot keep up does.
      }
    stream.destroy();
  }

  private async tick(): Promise<void> {
    const watchers = [...this.watchers.keys()].filter((watcher) =>
      watcher.wanted(),
    );
    // Without a watcher that wants it, the feed builds nothing.
    if (!watchers.length) return;
    try {
      const latest = await this.current();
      for (const watcher of watchers) {
        // A watcher that stopped meanwhile, or that has this rev, gets nothing.
        if ((this.watchers.get(watcher) ?? latest.rev) >= latest.rev) continue;
        this.watchers.set(watcher, latest.rev);
        try {
          watcher.show(latest);
        } catch {
          // The next change comes again.
        }
      }
    } catch {
      // A read that failed tries again at the next tick.
    }
  }

  /**
   * Give `show` the snapshot at once, then each change. `wanted`: while it
   * is false, the feed builds no snapshot for this watcher. Returns the
   * function that stops it.
   */
  watch(
    show: (latest: Latest) => void,
    wanted: () => boolean = () => true,
  ): () => void {
    const watcher: Watcher = { show, wanted };
    this.watchers.set(watcher, 0);
    this.start();
    void this.tick();
    return () => {
      this.watchers.delete(watcher);
      if (!this.watchers.size) this.stop();
    };
  }

  /** Tick while a watcher is open. */
  private start(): void {
    this.poll ??= setInterval(() => void this.tick(), this.pollMs).unref();
    this.beat ??= setInterval(() => {
      for (const stream of this.streams) this.write(stream, ': ping\n\n');
    }, this.heartbeatMs).unref();
  }

  /**
   * Open a stream: a watcher that writes the current snapshot at once, then
   * each change. False: too many streams are open.
   */
  async open(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (this.streams.size >= apiLimits.streams) return false;
    // The stream is quiet between changes, so the server's idle timeout does not apply to it.
    request.socket.setTimeout(0);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    this.streams.add(response);
    const unwatch = this.watch((latest) =>
      this.write(
        response,
        `id: ${this.epoch}.${latest.rev}\nevent: snapshot\ndata: ${latest.text}\n\n`,
      ),
    );
    response.on('close', () => {
      this.streams.delete(response);
      unwatch();
    });
    // The watch's first read. A stream that cannot get a snapshot closes.
    await this.current().catch(() => response.destroy());
    return true;
  }

  private stop(): void {
    clearInterval(this.poll);
    clearInterval(this.beat);
    this.poll = undefined;
    this.beat = undefined;
  }

  close(): void {
    this.stop();
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    this.watchers.clear();
  }
}

/** A watcher of the feed, such as an event stream or a terminal's view. */
interface Watcher {
  readonly show: (latest: Latest) => void;
  readonly wanted: () => boolean;
}

/** The lab actions that the API runs. Each runs the desk's own operation for it. */
const actionNames = new Set<string>([
  'lab-start',
  'lab-post',
  'lab-call-answer',
  'lab-call-words',
  'lab-call-undo',
  'lab-pause',
  'lab-resume',
  'lab-budget',
  'lab-direction-add',
  'lab-direction-stop',
  'lab-agent-restart',
  'lab-run-cancel',
  'lab-signoff',
  'lab-bring-look',
  'lab-bring',
  'lab-dismiss',
  'lab-away-dismiss',
  'lab-look',
  'lab-skip-questions',
  'lab-questions-answer',
  'compute-settings',
  'compute-gpus',
  'compute-agents',
  'compute-lease-approve',
  'compute-lease-deny',
  'compute-lease-stop',
  'compute-lease-start',
  'compute-lease-end',
  'compute-lease-dismiss',
  'compute-dismiss',
  'start-over',
] satisfies ActionName[]);

/** The first run's actions. The first run runs them, with or without a project. */
const setupNames = new Set<string>([
  'setup-agents',
  'setup-check',
  'setup-say',
  'setup-retry',
  'setup-fill',
  'setup-restart',
  'setup-about',
  'setup-key',
  'setup-prices',
  'setup-money',
  'setup-skip',
  'setup-skills-search',
  'setup-skill-add',
  'setup-skill-remove',
  'setup-skills-done',
  'setup-own-skills',
] satisfies ActionName[]);

/**
 * Verifold without a project: the Ask page's read, and the start of a
 * project with the person's question.
 */
export interface ProjectStart {
  readonly view: () => Promise<StartView>;
  /** Run `project-start`. Returns 202: the project starts in the background. */
  readonly act: (body: Record<string, unknown>) => Promise<number>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response
    .writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    .end(typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * History's reads: the list, one run, one task of a run, a transcript's
 * turns, and a task version's diff. The run is `current` or an archive ID.
 */
async function answerHistory(
  response: ServerResponse,
  url: URL,
  parts: readonly string[],
  reader: ApiReader,
): Promise<void> {
  const keys = [...url.searchParams.keys()];
  const [, run, third, fourth, fifth] = parts;
  const send = (value: unknown): void => {
    if (value) json(response, 200, value);
    else response.writeHead(404).end();
  };
  if (parts.length === 1 && !keys.length) {
    send(await reader.history());
    return;
  }
  if (!run || (run !== 'current' && !validArchiveId(run))) {
    json(response, 400, {
      error:
        'Name a run: current, or an archive ID such as 20261021T120000000Z-a1b2c3.',
    });
    return;
  }
  if (parts.length === 2 && !keys.length) {
    send(await reader.historyRun(run));
    return;
  }
  if (
    parts.length === 3 &&
    third === 'turns' &&
    keys.length === 1 &&
    keys[0] === 'source'
  ) {
    const source = url.searchParams.get('source') ?? '';
    if (source.length > 120) {
      json(response, 400, { error: 'Name a source such as session:<id>.' });
      return;
    }
    send(await reader.historyTurns(run, source));
    return;
  }
  if (third === 'tasks' && validTaskId(fourth)) {
    if (parts.length === 4 && !keys.length) {
      send(await reader.historyTask(run, fourth));
      return;
    }
    const version = Number(url.searchParams.get('version'));
    const file = url.searchParams.get('file') ?? '';
    if (
      parts.length === 5 &&
      fifth === 'diff' &&
      keys.length === 2 &&
      keys.includes('version') &&
      keys.includes('file') &&
      Number.isSafeInteger(version) &&
      version >= 1 &&
      file &&
      file.length <= 300
    ) {
      try {
        send(await reader.historyDiff(run, fourth, version, file));
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        json(response, 404, {
          error: `Verifold cannot show this diff: ${error.message}`,
        });
      }
      return;
    }
  }
  json(response, 400, { error: 'Verifold knows no such History read.' });
}

/**
 * Answer one request under /api/v1/. The desk checked its host and origin.
 * `authorized`: it has the desk's token. `act` runs a desk action and
 * returns 200, 202 when it goes on in the background, or 400. `setup` is
 * the first run, when the desk has one. `start` starts a project, when the
 * desk runs without one.
 */
export async function answerApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  authorized: boolean,
  feed: ApiFeed,
  reader: ApiReader,
  act: (body: Record<string, unknown>) => Promise<number>,
  setup?: Pick<FirstRun, 'view' | 'act'>,
  start?: ProjectStart,
): Promise<void> {
  if (!authorized) {
    response.writeHead(401).end();
    return;
  }
  const parts = url.pathname.slice('/api/v1/'.length).split('/');
  const [first, second, third, fourth] = parts;
  if (first === 'actions' && parts.length === 2) {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (
      !/^application\/json(;|$)/i.test(request.headers['content-type'] ?? '')
    ) {
      response.writeHead(415).end();
      return;
    }
    const setupAction =
      second !== undefined && setupNames.has(second) ? setup : undefined;
    const startAction = second === 'project-start' ? start : undefined;
    if (
      url.search ||
      !second ||
      !(setupAction || startAction || actionNames.has(second))
    ) {
      json(response, 404, { error: 'Verifold knows no such action.' });
      return;
    }
    const body = await readJsonBody(request, apiLimits.body);
    if (!record(body)) {
      json(response, 400, { error: 'The action needs a JSON object.' });
      return;
    }
    let status: number;
    try {
      status = await (setupAction ?? startAction ?? { act }).act({
        ...body,
        action: second,
      });
    } catch (error) {
      if (!(error instanceof SessionActionError)) throw error;
      json(response, 409, { error: error.message });
      return;
    }
    json(
      response,
      status,
      status === 200
        ? { ok: true }
        : status === 202
          ? { ok: true, pending: true }
          : { error: 'Verifold cannot run this action here.' },
    );
    return;
  }
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' }).end();
    return;
  }
  const keys = [...url.searchParams.keys()];
  const before = url.searchParams.get('before');
  const onlyBefore = keys.length <= 1 && keys.every((key) => key === 'before');
  if (first === 'snapshot' && parts.length === 1 && !keys.length) {
    json(response, 200, (await feed.current()).text);
    return;
  }
  if (first === 'start' && parts.length === 1 && !keys.length && start) {
    json(response, 200, await start.view());
    return;
  }
  if (first === 'history') {
    await answerHistory(response, url, parts, reader);
    return;
  }
  if (first === 'setup' && parts.length === 1 && !keys.length && setup) {
    try {
      json(response, 200, await setup.view());
    } catch (error) {
      if (!(error instanceof SessionActionError)) throw error;
      json(response, 409, { error: error.message });
    }
    return;
  }
  if (first === 'events' && parts.length === 1 && !keys.length) {
    if (!(await feed.open(request, response))) response.writeHead(503).end();
    return;
  }
  if (
    first === 'search' &&
    parts.length === 1 &&
    keys.length <= 1 &&
    keys.every((key) => key === 'q')
  ) {
    const q = url.searchParams.get('q') ?? '';
    if (q.length > searchQueryLimit) {
      response.writeHead(400).end();
      return;
    }
    const result = reader.search(q);
    if (result) json(response, 200, result);
    else response.writeHead(404).end();
    return;
  }
  if (first === 'posts' && parts.length === 2 && !keys.length) {
    if (!second || !postId.test(second)) {
      response.writeHead(400).end();
      return;
    }
    const thread = reader.thread(second);
    if (thread) json(response, 200, thread);
    else response.writeHead(404).end();
    return;
  }
  if (first === 'figures' && parts.length === 2 && !keys.length) {
    if (!second || !proofRef(second)) {
      json(response, 400, {
        error: 'Name a figure by its post and place, such as p-12.0.',
      });
      return;
    }
    const read = await reader.figure(second);
    if (!read) {
      json(response, 404, { error: 'Verifold runs no lab here.' });
      return;
    }
    if ('missing' in read) {
      json(response, 404, { error: read.missing });
      return;
    }
    if ('changed' in read) {
      json(response, 409, { error: read.changed });
      return;
    }
    if ('large' in read) {
      json(response, 413, { error: read.large });
      return;
    }
    // The lab reads only a figure extension.
    const type = figureType(read.path) ?? 'application/octet-stream';
    // The browser decodes every pixel that an image declares, so a huge one never reaches it.
    if (type.startsWith('image/') && type !== 'image/svg+xml') {
      const size = imageSize(type, read.content);
      if (
        !size ||
        size.width > figurePixels.side ||
        size.height > figurePixels.side ||
        size.width * size.height > figurePixels.total
      ) {
        json(response, 413, {
          error: size
            ? `This image is ${size.width} × ${size.height} pixels. Verifold shows images up to ${figurePixels.side} pixels on a side and ${figurePixels.total / 1_000_000} million pixels in all.`
            : 'Verifold cannot read the size of this image, so it does not show it.',
        });
        return;
      }
    }
    response
      .writeHead(200, figureHeaders(read.path, type, read.content.length))
      .end(read.content);
    return;
  }
  if (first === 'board' && parts.length === 1 && onlyBefore) {
    if (before !== null && !postId.test(before)) {
      response.writeHead(400).end();
      return;
    }
    const page = reader.board(before === null ? undefined : number(before));
    if (page) json(response, 200, page);
    else response.writeHead(404).end();
    return;
  }
  if (
    first === 'directions' &&
    second &&
    directionId.test(second) &&
    third === 'bring'
  ) {
    if (parts.length === 3 && !keys.length) {
      const read = await reader.bring(second);
      if (read) json(response, 200, read);
      else response.writeHead(404).end();
      return;
    }
    if (parts.length === 4 && fourth === 'diff') {
      const file = url.searchParams.get('file') ?? '';
      const commit = url.searchParams.get('commit') ?? '';
      if (
        !file ||
        file.length > 300 ||
        !commitId.test(commit) ||
        keys.length !== 2 ||
        !keys.includes('file') ||
        !keys.includes('commit')
      ) {
        response.writeHead(400).end();
        return;
      }
      try {
        const shown = await reader.bringDiff(second, file, commit);
        if (shown) json(response, 200, shown);
        else response.writeHead(404).end();
      } catch (error) {
        if (!(error instanceof SessionActionError)) throw error;
        json(response, 404, { error: error.message });
      }
      return;
    }
  }
  if (first === 'runs' && parts.length === 2 && !keys.length) {
    if (!second || !runId.test(second)) {
      json(response, 400, { error: 'Name a run such as r-3.' });
      return;
    }
    const detail = await reader.run(second);
    if (detail) json(response, 200, detail);
    else response.writeHead(404).end();
    return;
  }
  if (
    first === 'directions' &&
    second &&
    directionId.test(second) &&
    third === 'diff' &&
    parts.length === 3
  ) {
    const file = url.searchParams.get('file');
    const proof = url.searchParams.get('proof');
    if (
      new Set(keys).size !== keys.length ||
      !keys.every((key) => key === 'file' || key === 'proof') ||
      (file !== null && (!file || file.length > 300)) ||
      (proof !== null && !proofRef(proof))
    ) {
      json(response, 400, {
        error:
          'Ask for at most one file, with a path of 1 to 300 characters, and at most one proof such as p-12.0.',
      });
      return;
    }
    try {
      const shown = await reader.directionDiff(
        second,
        file ?? undefined,
        proof ?? undefined,
      );
      if (shown) json(response, 200, shown);
      else response.writeHead(404).end();
    } catch (error) {
      if (!(error instanceof SessionActionError)) throw error;
      json(response, 404, { error: error.message });
    }
    return;
  }
  // A turn's steps also take `limit` (1 to 200) and `tools=1`.
  const stepQuery =
    new Set(keys).size === keys.length &&
    keys.every((key) => key === 'before' || key === 'limit' || key === 'tools');
  const limit = url.searchParams.get('limit');
  const tools = url.searchParams.get('tools');
  if (
    first === 'agents' &&
    second &&
    agentId.test(second) &&
    third === 'turns'
  ) {
    if (parts.length === 3 && onlyBefore) {
      if (before !== null && !turnIdPattern.test(before)) {
        response.writeHead(400).end();
        return;
      }
      const page = await reader.turnPage(second, before ?? undefined);
      if (page) json(response, 200, page);
      else response.writeHead(404).end();
      return;
    }
    if (parts.length === 4 && fourth && stepQuery) {
      let id: string;
      try {
        id = decodeURIComponent(fourth);
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (
        !turnIdPattern.test(id) ||
        (before !== null && !/^(0|[1-9]\d{0,6})$/.test(before)) ||
        (limit !== null && !/^([1-9]\d?|1\d\d|200)$/.test(limit)) ||
        (tools !== null && tools !== '1')
      ) {
        response.writeHead(400).end();
        return;
      }
      const detail = await reader.turn(
        second,
        id,
        before === null ? undefined : Number(before),
        {
          ...(limit === null ? {} : { limit: Number(limit) }),
          ...(tools === null ? {} : { tools: true }),
        },
      );
      if (detail) json(response, 200, detail);
      else response.writeHead(404).end();
      return;
    }
  }
  response.writeHead(404).end();
}
