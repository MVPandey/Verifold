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
  type Post,
  type Proof,
  type Run,
  type Snapshot,
  type Step,
  type Text,
  type Turn,
  type TurnDetail,
  type TurnPage,
  type Work,
} from '../protocol/api.ts';

/**
 * The desk API, version 1, under /api/v1/: a snapshot of what the screens
 * show, a stream that sends it again when it changes, pages of the board and
 * of an agent's turns, and actions. The desk's token and origin checks run
 * before any of it. See src/protocol/api.ts for the shapes.
 */

export const apiLimits = {
  /** Bytes of one snapshot. A bigger lab gets fewer turns, posts, and characters. */
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
  /** Steps of one turn that the server sends. */
  steps: 400,
  /** Ended checks whose checkers show among the agents. */
  endedCheckers: 5,
  /** Open event streams at once. */
  streams: 4,
  /** Bytes that may wait for a slow stream. Past them the server drops the stream. */
  backlog: 8 * 1024 * 1024,
  /** Bytes of an action's body. */
  body: 512_000,
  /** Transcript files that the server follows at once. */
  transcripts: 32,
};

/**
 * What a snapshot holds at each size level. A snapshot uses the first level
 * that fits `apiLimits.snapshot`, and any level after the first marks it
 * trimmed. A message bound of 0 leaves the messages out.
 */
const levels = [
  { turns: 20, message: 2000, posts: 50, calls: 20, runs: 30, checks: 30 },
  { turns: 5, message: 500, posts: 50, calls: 10, runs: 20, checks: 20 },
  { turns: 3, message: 0, posts: 20, calls: 5, runs: 10, checks: 10 },
  { turns: 0, message: 0, posts: 5, calls: 0, runs: 0, checks: 0 },
] as const;
type Level = (typeof levels)[number];

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

/** The snapshot without the fields that the stream sets: its version, rev, and time. */
type SnapshotData = Omit<Snapshot, 'protocolVersion' | 'rev' | 'at'>;

const cents = (usd: number): number => Math.round(usd * 100) / 100;

/** A text of at most `max` characters. */
function text(value: string, max: number): Text {
  return { text: clip(value, max), trimmed: value.length > max };
}

/** The first `max` bytes of a text. */
function head(value: string, max: number): Text {
  const bytes = Buffer.from(value);
  return bytes.length <= max
    ? { text: value, trimmed: false }
    : { text: bytes.subarray(0, max).toString('utf8'), trimmed: true };
}

/** The last `max` bytes of a text. */
function tail(value: string, max: number): Text {
  const bytes = Buffer.from(value);
  return bytes.length <= max
    ? { text: value, trimmed: false }
    : {
        text: bytes.subarray(bytes.length - max).toString('utf8'),
        trimmed: true,
      };
}

/** The lab's agents: each direction's agent, then the checkers that wait or run and the newest that ended. */
function agentsOf(view: LabView): AgentRef[] {
  const going = (check: LabCheck): boolean =>
    check.state === 'queued' || check.state === 'running';
  const ended = new Set(
    view.checks
      .filter((check) => !going(check))
      .slice(-apiLimits.endedCheckers),
  );
  return [
    ...view.directions.map((entry) => ({
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
    })),
    ...view.checks
      .filter((check) => going(check) || ended.has(check))
      .map((check) => ({
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
      })),
  ];
}

/** A turn runs while its agent works and no later turn started. */
const working = (agent: AgentRef): boolean =>
  agent.status === 'working' || agent.status === 'running';

function turn(entry: ActivityTurn, running: boolean, message: number): Turn {
  return {
    id: entry.id,
    startedAt: entry.startedAt,
    endedAt: running ? null : entry.lastAt,
    counts: entry.counts,
    message:
      message && entry.message !== null ? text(entry.message, message) : null,
  };
}

/** The page of turns that ends before `before`, or the newest page. */
function turnPage(
  agent: AgentRef,
  turns: readonly ActivityTurn[],
  size: number,
  message: number,
  before?: number,
): TurnPage {
  const end = before ?? turns.length;
  const start = Math.max(0, end - size);
  const newest = turns.at(-1);
  return {
    turns: turns
      .slice(start, end)
      .map((entry) => turn(entry, working(agent) && entry === newest, message)),
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
    askers: [
      ...(entry.by === 'verifold'
        ? []
        : [
            {
              agent: entry.by,
              handle: handle(entry.by),
              direction: entry.direction,
              why: entry.why,
            },
          ]),
      ...entry.joined.map((asker) => ({
        agent: asker.agent,
        handle: handle(asker.agent),
        direction: asker.direction,
        why: asker.why,
      })),
    ],
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
): Direction {
  return {
    id: entry.id,
    title: entry.title,
    bar: entry.bar,
    runs: entry.runs,
    noise: entry.noise,
    buildsOn: entry.buildsOn.map((work) => ({
      text: work.text,
      known: work.known,
    })),
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

/** The lab as the screens show it, within one size level. */
function shapeLab(loaded: Loaded, level: Level): Lab {
  const { view } = loaded;
  const { state } = view;
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
  const agents: Agent[] = loaded.agents.map((ref) => {
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
      turns: turnPage(ref, turns, level.turns, level.message),
      spendUsd: ref.spend,
    };
  });
  return {
    question: state.question,
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
    needsYou: state.calls.filter(waiting).map((entry) => call(entry, handle)),
    answered: state.calls
      .filter((entry) => !waiting(entry))
      .slice(level.calls ? -level.calls : state.calls.length)
      .reverse()
      .map((entry) => call(entry, handle)),
    directions: state.directions.map((entry) => direction(entry, disputed)),
    agents,
    plan: state.plan
      ? {
          post: state.plan.post,
          at: state.plan.at,
          reading: state.plan.reading,
          cost: state.plan.cost,
          directions: [...state.plan.directions],
          facts: state.plan.facts.map((fact) => ({
            claim: fact.claim,
            source: fact.source,
            sourceDate: fact.sourceDate,
            listedAt: fact.checkedAt,
          })),
        }
      : null,
    board: boardPage(view.posts, level.posts, handle),
    disputes: disputes.map((entry) => ({
      post: entry.target.id,
      objections: entry.objections.map((objection) => objection.id),
      check: entry.check?.id ?? null,
    })),
    runs: level.runs ? view.ledger.slice(-level.runs).map(run) : [],
    checks: level.checks ? view.checks.slice(-level.checks).map(check) : [],
    signoff: state.signoff
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
    works: loaded.works.map((work) => ({
      action: work.action,
      label: work.label,
      at: work.at,
      error: work.error,
    })),
    away: loaded.away,
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
function step(entry: TranscriptEntry): Step {
  const tool = entry.kind === 'tool';
  return {
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

/**
 * Reads what the API sends: the lab's records, and each agent's transcript.
 * It follows a few transcript files and reads only their new lines, and it
 * groups a transcript into turns again only when the transcript changed.
 */
export class ApiReader {
  private readonly sources: () => ApiSources;
  private readonly files = new Map<string, TranscriptFile>();
  private readonly turns = new Map<
    string,
    { readonly key: string; readonly turns: readonly ActivityTurn[] }
  >();

  constructor(sources: () => ApiSources) {
    this.sources = sources;
  }

  /** The turns of a session's transcript, oldest first. */
  private async turnsOf(
    root: string,
    session: string | null,
  ): Promise<readonly ActivityTurn[]> {
    const path = session ? sessionTranscript(root, session) : null;
    if (!path) return [];
    const file = this.files.get(path) ?? new TranscriptFile(path);
    // The least recently read file leaves first.
    this.files.delete(path);
    this.files.set(path, file);
    for (const old of [...this.files.keys()].slice(0, -apiLimits.transcripts)) {
      this.files.delete(old);
      this.turns.delete(old);
    }
    await file.refresh();
    const key = `${file.log.epoch}:${file.log.last}`;
    const known = this.turns.get(path);
    if (known?.key === key) return known.turns;
    const turns = turnsOf(file.log.list());
    this.turns.set(path, { key, turns });
    return turns;
  }

  private async load(): Promise<Loaded | null> {
    const sources = this.sources();
    const view = sources.lab?.view() ?? null;
    if (!view || !sources.root) return null;
    const root = sources.root;
    const agents = agentsOf(view);
    const turns = new Map<string, readonly ActivityTurn[]>();
    const models = new Map<string, string>();
    for (const agent of agents) {
      turns.set(agent.id, await this.turnsOf(root, agent.session));
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

  /** The snapshot without its rev and time, within the size bound. */
  async snapshot(): Promise<SnapshotData> {
    const root = this.sources().root;
    const project = root ? basename(root) : '';
    const loaded = await this.load();
    if (!loaded) return { project, lab: null, trimmed: false };
    // The stream adds the version, the rev, and the time.
    const room = apiLimits.snapshot - 256;
    for (const [index, level] of levels.entries()) {
      const data = {
        project,
        lab: shapeLab(loaded, level),
        trimmed: index > 0,
      };
      if (Buffer.byteLength(JSON.stringify(data)) <= room) return data;
    }
    throw new Error('The lab snapshot exceeds its size bound.');
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

  /** An agent of the lab with its turns. Null when the lab has no such agent. */
  private async agent(id: string): Promise<{
    readonly agent: AgentRef;
    readonly turns: readonly ActivityTurn[];
  } | null> {
    const sources = this.sources();
    const view = sources.lab?.view();
    if (!view || !sources.root) return null;
    const agent = agentsOf(view).find((entry) => entry.id === id);
    if (!agent) return null;
    return { agent, turns: await this.turnsOf(sources.root, agent.session) };
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
    return turnPage(
      found.agent,
      found.turns,
      apiLimits.turns,
      apiLimits.message,
      end,
    );
  }

  /** One turn with its steps. Null: no such agent or turn. */
  async turn(id: string, turnId: string): Promise<TurnDetail | null> {
    const found = await this.agent(id);
    const entry = found?.turns.find((item) => item.id === turnId);
    if (!found || !entry) return null;
    return {
      turn: turn(
        entry,
        working(found.agent) && entry === found.turns.at(-1),
        apiLimits.message,
      ),
      steps: entry.entries.slice(0, apiLimits.steps).map(step),
      more: entry.entries.length > apiLimits.steps,
    };
  }
}

/** One event of the stream. JSON has no line breaks, so the data fits one line. */
function event(snapshot: Snapshot): string {
  return `id: ${snapshot.rev}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

/**
 * The snapshot and its stream. While a stream is open, the feed builds the
 * snapshot every `pollMs` and sends it to each stream that has an older rev.
 * Changes in one interval reach a stream as one snapshot. The rev grows only
 * when the data changed.
 */
export class ApiFeed {
  private readonly reader: ApiReader;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private rev = 0;
  private body: string | null = null;
  private building: Promise<Snapshot> | null = null;
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

  /** The newest snapshot. Calls at the same time share one build. */
  current(): Promise<Snapshot> {
    this.building ??= this.build().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async build(): Promise<Snapshot> {
    const data = await this.reader.snapshot();
    const body = JSON.stringify(data);
    if (body !== this.body) {
      this.body = body;
      this.rev += 1;
    }
    return {
      protocolVersion,
      rev: this.rev,
      at: new Date().toISOString(),
      ...data,
    };
  }

  /** Send the snapshot to a stream that has an older one. A stream that cannot keep up closes. */
  private send(stream: ServerResponse, snapshot: Snapshot): void {
    const last = this.streams.get(stream);
    if (last === undefined || last >= snapshot.rev || !stream.writable) return;
    if (stream.writableLength > apiLimits.backlog) {
      stream.destroy();
      return;
    }
    this.streams.set(stream, snapshot.rev);
    stream.write(event(snapshot));
  }

  private async tick(): Promise<void> {
    try {
      const snapshot = await this.current();
      for (const stream of this.streams.keys()) this.send(stream, snapshot);
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
        if (stream.writable) stream.write(': ping\n\n');
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response
    .writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(body));
}

/** Read a JSON body of at most `limit` bytes. Null when it is too big or not JSON. */
async function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
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
    const body = await readBody(request, apiLimits.body);
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
      status === 200 || status === 202 ? 200 : status,
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
  const onlyBefore = keys.every((key) => key === 'before') && keys.length <= 1;
  if (first === 'snapshot' && parts.length === 1 && !keys.length) {
    json(response, 200, await feed.current());
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
    if (parts.length === 4 && fourth && !keys.length) {
      let id: string;
      try {
        id = decodeURIComponent(fourth);
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (!turnId.test(id)) {
        response.writeHead(400).end();
        return;
      }
      const detail = await reader.turn(second, id);
      if (detail) json(response, 200, detail);
      else response.writeHead(404).end();
      return;
    }
  }
  response.writeHead(404).end();
}
