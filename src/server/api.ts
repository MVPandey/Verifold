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
  clip,
  number,
  postId,
  type Artifact,
  type Post as BoardPost,
} from '../core/board.ts';
import { labGpu, type ComputeView } from '../core/compute.ts';
import { openDisputes } from '../core/disputes.ts';
import type { HarnessName } from '../core/harness.ts';
import {
  askers,
  type Call as LabCall,
  type CallEffect,
  type Check as LabCheck,
  type Direction as LabDirection,
  type LabView,
} from '../core/lab.ts';
import type { RunRecord } from '../core/runs.ts';
import {
  SessionActionError,
  sessionTranscript,
  type SessionView,
} from '../core/session.ts';
import { TranscriptFile, type TranscriptEntry } from '../core/transcript.ts';
import {
  protocolVersion,
  type ActionName,
  type Agent,
  type AgentStatus,
  type BoardPage,
  type Call,
  type CallOption,
  type CheckItem,
  type Direction,
  type Effect,
  type Lab,
  type LabList,
  type Post,
  type Proof,
  type Run,
  type Step,
  type Text,
  type Turn,
  type TurnPage,
  type Work,
} from '../protocol/api.ts';
import { readJsonBody, record } from './http.ts';

/**
 * The desk API, version 1, under /api/v1/: a snapshot of what the screens
 * show, a stream that sends it again when it changes, pages of the board, of
 * an agent's turns, and of a turn's steps, and actions. The desk's host,
 * origin, and token checks run before any of it. See src/protocol/api.ts for
 * the shapes.
 */

export const apiLimits = {
  /** Bytes of one snapshot. A bigger lab gets fewer items and characters. */
  snapshot: 512 * 1024,
  /** Posts in a snapshot and in one page of the board. */
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
  /** It keeps the plan, the sign-off, and the whole question. */
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
 * level keeps no list, no plan, and a cut question, so it always fits.
 */
const levels: readonly Level[] = [
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
  readonly away: () => Promise<{
    readonly since: string;
    readonly spent: { readonly claude: number; readonly gpu: number };
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
  readonly works: readonly Work[];
  readonly away: Lab['away'];
  readonly turns: ReadonlyMap<string, readonly ActivityTurn[]>;
  readonly models: ReadonlyMap<string, string>;
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

function foldTurn(
  entry: ActivityTurn,
  running: boolean,
  message: number,
): Turn {
  return {
    id: entry.id,
    startedAt: entry.startedAt,
    endedAt: running ? null : entry.lastAt,
    counts: entry.counts,
    message:
      message && entry.message !== null ? text(entry.message, message) : null,
  };
}

/** The page of turns that ends before index `end`, or the newest page. */
function pageOfTurns(
  agent: AgentRef,
  turns: readonly ActivityTurn[],
  size: number,
  message: number,
  end = turns.length,
): TurnPage {
  const start = Math.max(0, end - size);
  const newest = turns.at(-1);
  return {
    turns: turns
      .slice(start, end)
      .map((entry) =>
        foldTurn(entry, working(agent) && entry === newest, message),
      ),
    more: start > 0,
  };
}

function effect(value: CallEffect): Effect {
  switch (value.type) {
    case 'pod':
      return {
        type: 'pod',
        gpu: value.gpuType,
        hours: value.hours,
        secrets: value.secrets.length,
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

function call(entry: LabCall, handle: (agent: string) => string): Call {
  const options: CallOption[] = entry.options.map((option) => ({
    label: option.label,
    usd: option.usd,
    minutes: option.minutes,
    effect: option.effect ? effect(option.effect) : null,
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
    state: entry.state,
    answer: entry.answer
      ? { option: entry.answer.option, at: entry.answer.at }
      : null,
    words: entry.words,
    undoUntil: entry.undoUntil,
    note: entry.note,
    post: entry.post,
  };
}

function direction(
  entry: LabDirection,
  disputed: (entry: LabDirection) => boolean,
  buildsOn: readonly LabDirection['buildsOn'][number][],
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

/** The lab as the screens show it, within one level. */
function shapeLab(loaded: Loaded, level: Level): Lab {
  const { view } = loaded;
  const { state } = view;
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
  const disputes = openDisputes(view);
  const disputed = (entry: LabDirection): boolean =>
    disputes.some(
      ({ target }) =>
        target.direction === entry.id || target.id === entry.evidence?.post,
    );
  const gpu = loaded.compute
    ? labGpu(loaded.compute, state.startedAt)
    : { spent: 0, limit: null };
  const waiting = (entry: LabCall): boolean =>
    entry.state === 'open' || entry.state === 'undoing';
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
        turns: pageOfTurns(ref, turns, level.turns, level.message),
        spendUsd: ref.spend,
      };
    },
  );
  const plan = state.plan;
  if (plan && !level.whole) omitted.plan = 1;
  if (state.signoff && !level.whole) omitted.signoff = 1;
  return {
    question: level.whole
      ? state.question
      : clip(state.question, apiLimits.question),
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
    },
    // The calls that waited longest come first.
    needsYou: keep(state.calls.filter(waiting), level.needsYou, 'needsYou').map(
      (entry) => call(entry, handle),
    ),
    answered: keep(
      state.calls.filter((entry) => !waiting(entry)),
      level.answered,
      'answered',
      true,
    )
      .reverse()
      .map((entry) => call(entry, handle)),
    directions: keep(state.directions, level.directions, 'directions').map(
      (entry) =>
        direction(
          entry,
          disputed,
          keep(entry.buildsOn, level.buildsOn, 'buildsOn'),
        ),
    ),
    agents,
    plan:
      plan && level.whole
        ? {
            post: plan.post,
            at: plan.at,
            reading: plan.reading,
            cost: plan.cost,
            directions: [...plan.directions],
            facts: keep(plan.facts, level.facts, 'facts').map((fact) => ({
              claim: fact.claim,
              source: fact.source,
              sourceDate: fact.sourceDate,
              listedAt: fact.checkedAt,
            })),
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
    signoff:
      state.signoff && level.whole
        ? {
            at: state.signoff.at,
            note: state.signoff.note,
            directions: state.signoff.directions.map((entry) => ({
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
    })),
    away: loaded.away,
    omitted,
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
    if (!view || !root) return parts;
    parts.push(view.posts.length, view.posts.at(-1), ...view.ledger);
    for (const entry of view.directions)
      parts.push(entry.agent, entry.status, entry.until);
    const compute = sources.compute?.view();
    if (compute) {
      const gpu = labGpu(compute, view.state.startedAt);
      parts.push(cents(gpu.spent), gpu.limit);
    }
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
    for (const [index, agent] of agents.entries()) {
      turns.set(agent.id, this.turnsOf(followed[index] ?? null));
      const reported = agent.session
        ? sources.session(agent.session)?.record.reportedModel
        : undefined;
      if (reported) models.set(agent.id, reported);
    }
    const away = view.runs ? await sources.away() : null;
    return {
      view,
      agents,
      compute: sources.compute?.view() ?? null,
      works: sources.works,
      away: away
        ? {
            since: away.since,
            spentThen: {
              plansUsd: cents(away.spent.claude),
              gpuUsd: cents(away.spent.gpu),
            },
          }
        : null,
      turns,
      models,
    };
  }

  /**
   * The snapshot without its version, epoch, rev, and time, as JSON, within
   * the size bound. The string is all that the feed measures, compares, and
   * sends, so the snapshot is serialized once.
   */
  async snapshot(): Promise<string> {
    const root = this.sources().root;
    const project = root ? basename(root) : '';
    const loaded = await this.load();
    if (!loaded) return JSON.stringify({ project, lab: null, trimmed: false });
    // The feed adds the version, the epoch, the rev, and the time.
    const room = apiLimits.snapshot - 256;
    let json = '';
    for (const [index, level] of levels.entries()) {
      const lab = shapeLab(loaded, level);
      json = JSON.stringify({
        project,
        lab,
        trimmed: index > 0 || Object.keys(lab.omitted).length > 0,
      });
      if (Buffer.byteLength(json) <= room) break;
    }
    return json;
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

  /** Any agent of the lab, with its turns. Null when the lab has no such agent. */
  private async agent(id: string): Promise<{
    readonly agent: AgentRef;
    readonly turns: readonly ActivityTurn[];
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
    return { agent, turns: this.turnsOf(followed) };
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
      end,
    );
  }

  /**
   * One turn with a page of its steps, as JSON: the newest steps, or those
   * before index `before`. A page holds at most `apiLimits.steps` steps and
   * about `apiLimits.stepPage` bytes, and always at least one step. Null: no
   * such agent, turn, or step.
   */
  async turn(
    id: string,
    turnId: string,
    before?: number,
  ): Promise<string | null> {
    const found = await this.agent(id);
    const entry = found?.turns.find((item) => item.id === turnId);
    if (!found || !entry) return null;
    const end = before ?? entry.entries.length;
    if (end > entry.entries.length) return null;
    const steps: string[] = [];
    let bytes = 0;
    let start = end;
    while (start > 0 && steps.length < apiLimits.steps) {
      const item = entry.entries[start - 1];
      if (!item) break;
      const json = JSON.stringify(step(item, start - 1));
      const size = Buffer.byteLength(json);
      if (steps.length && bytes + size > apiLimits.stepPage) break;
      steps.unshift(json);
      bytes += size;
      start--;
    }
    const shown = foldTurn(
      entry,
      working(found.agent) && entry === found.turns.at(-1),
      apiLimits.message,
    );
    return `{"turn":${JSON.stringify(shown)},"steps":[${steps.join(',')}],"more":${start > 0}}`;
  }
}

/**
 * The snapshot and its stream. At each tick the feed reads cheap signals of
 * the lab. Only when one moved does it build the snapshot, and only when the
 * data changed does the rev grow and the stream send it. An idle lab costs a
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
  private latest: { readonly rev: number; readonly text: string } | null = null;
  private building: Promise<{
    readonly rev: number;
    readonly text: string;
  }> | null = null;
  private built = 0;
  /** Each open stream, with the rev that it got last. */
  private readonly streams = new Map<ServerResponse, number>();
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

  /** The newest snapshot as JSON, with its rev. Calls at the same time share one read. */
  current(): Promise<{ readonly rev: number; readonly text: string }> {
    this.building ??= this.refresh().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async refresh(): Promise<{
    readonly rev: number;
    readonly text: string;
  }> {
    const signal = await this.reader.signal();
    if (this.latest && this.signal && same(signal, this.signal))
      return this.latest;
    const body = await this.reader.snapshot();
    this.built += 1;
    this.signal = signal;
    if (this.latest && body === this.body) return this.latest;
    this.body = body;
    this.rev += 1;
    // The data's JSON goes in as it is, after the fields that the feed sets.
    this.latest = {
      rev: this.rev,
      text: `{"protocolVersion":${protocolVersion},"epoch":"${this.epoch}","rev":${this.rev},"at":"${new Date().toISOString()}",${body.slice(1)}`,
    };
    return this.latest;
  }

  /** Write to a stream, or drop it when it cannot keep up. */
  private write(stream: ServerResponse, chunk: string): void {
    if (stream.writableLength > apiLimits.backlog) {
      stream.destroy();
      return;
    }
    if (stream.writable) stream.write(chunk);
  }

  /** Send the snapshot to a stream that has an older one. */
  private send(
    stream: ServerResponse,
    latest: { readonly rev: number; readonly text: string },
  ): void {
    const last = this.streams.get(stream);
    if (last === undefined || last >= latest.rev) return;
    this.streams.set(stream, latest.rev);
    this.write(
      stream,
      `id: ${this.epoch}.${latest.rev}\nevent: snapshot\ndata: ${latest.text}\n\n`,
    );
  }

  private async tick(): Promise<void> {
    try {
      const latest = await this.current();
      for (const stream of this.streams.keys()) this.send(stream, latest);
    } catch {
      // A read that failed tries again at the next tick.
    }
  }

  /** Open a stream: the current snapshot at once, then each change. False: too many streams are open. */
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
    this.streams.set(response, 0);
    response.on('close', () => {
      this.streams.delete(response);
      if (!this.streams.size) this.stop();
    });
    this.poll ??= setInterval(() => void this.tick(), this.pollMs).unref();
    this.beat ??= setInterval(() => {
      for (const stream of this.streams.keys())
        this.write(stream, ': ping\n\n');
    }, this.heartbeatMs).unref();
    try {
      this.send(response, await this.current());
    } catch {
      response.destroy();
    }
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
    for (const stream of this.streams.keys()) stream.end();
    this.streams.clear();
  }
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
  'lab-dismiss',
  'lab-away-dismiss',
] satisfies ActionName[]);

/** A turn ID: an entry ID of a transcript, such as `1a2b3c4d.#3` or `1a2b3c4d.toolu_01`. */
const turnId = /^[0-9a-f]{8}\.[\w#:.-]{1,120}$/;

function json(response: ServerResponse, status: number, body: unknown): void {
  response
    .writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    .end(typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * Answer one request under /api/v1/. The desk checked its host and origin.
 * `authorized`: it has the desk's token. `act` runs a desk action and
 * returns 200, 202 when it goes on in the background, or 400.
 */
export async function answerApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  authorized: boolean,
  feed: ApiFeed,
  reader: ApiReader,
  act: (body: Record<string, unknown>) => Promise<number>,
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
    if (url.search || !second || !actionNames.has(second)) {
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
      status = await act({ ...body, action: second });
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
  if (first === 'events' && parts.length === 1 && !keys.length) {
    if (!(await feed.open(request, response))) response.writeHead(503).end();
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
    first === 'agents' &&
    second &&
    agentId.test(second) &&
    third === 'turns' &&
    onlyBefore
  ) {
    if (parts.length === 3) {
      if (before !== null && !turnId.test(before)) {
        response.writeHead(400).end();
        return;
      }
      const page = await reader.turnPage(second, before ?? undefined);
      if (page) json(response, 200, page);
      else response.writeHead(404).end();
      return;
    }
    if (parts.length === 4 && fourth) {
      let id: string;
      try {
        id = decodeURIComponent(fourth);
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (
        !turnId.test(id) ||
        (before !== null && !/^(0|[1-9]\d{0,6})$/.test(before))
      ) {
        response.writeHead(400).end();
        return;
      }
      const detail = await reader.turn(
        second,
        id,
        before === null ? undefined : Number(before),
      );
      if (detail) json(response, 200, detail);
      else response.writeHead(404).end();
      return;
    }
  }
  response.writeHead(404).end();
}
