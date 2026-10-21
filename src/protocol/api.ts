/**
 * The desk API, version 1: the data that the server sends to the app, and
 * the actions that the app sends back. These are plain types with a few
 * constants and no imports, so the server, the desk, and the app can share
 * them.
 *
 * Times are ISO 8601 strings. Money is in USD. The server never puts
 * internal record fields, keys, or paths outside the project into these
 * shapes. A text that the server cut says so in its `trimmed` field.
 *
 * Changes: a field added after version 1 shipped is optional, and a client
 * handles its absence, so an older server and a newer page still work
 * together. Only a change that breaks that, such as a removed or retyped
 * field, raises `protocolVersion`.
 */
export const protocolVersion = 1;

/**
 * A turn's ID: the ID of the turn's first transcript entry, such as
 * `1a2b3c4d.#3` or `1a2b3c4d.toolu_01`. The API and the app's links check it
 * with this.
 */
export const turnIdPattern = /^[0-9a-f]{8}\.[\w#:.-]{1,120}$/;

export type Harness = 'claude' | 'codex';

/** A text that can be long, cut to a bound. `trimmed`: the server cut it. */
export interface Text {
  readonly text: string;
  readonly trimmed: boolean;
}

/**
 * What the screens show, at one moment. `GET /api/v1/snapshot` and each
 * `snapshot` event send one. Compare snapshots by `epoch` and `rev`: a new
 * epoch means that Verifold started again, so take the snapshot as new,
 * whatever its rev.
 */
export interface Snapshot {
  readonly protocolVersion: typeof protocolVersion;
  /** A new one each time Verifold starts. */
  readonly epoch: string;
  /** Grows by one with each change within an epoch. Two snapshots with the same epoch and rev hold the same data. */
  readonly rev: number;
  /** When the server built it. */
  readonly at: string;
  /**
   * The name of the project's folder. Empty when Verifold runs without a
   * project, as for the first run in a new folder.
   */
  readonly project: string;
  /** Null: the project has no lab. */
  readonly lab: Lab | null;
  /**
   * A project without a lab: its question, so the page can start the lab
   * on it, or null when it has none. Added after version 1.
   */
  readonly question?: string | null;
  /** A project without a lab: why its lab's last start failed, or null. Added after version 1. */
  readonly startProblem?: string | null;
  /** The snapshot left items out: lists past their bounds, or less of a large lab to stay under the size bound. */
  readonly trimmed: boolean;
}

/** The lists of a lab that a snapshot can cut. Posts and turns have their own `more` flags. */
export type LabList =
  | 'needsYou'
  | 'answered'
  | 'directions'
  | 'buildsOn'
  | 'agents'
  | 'disputes'
  | 'facts'
  | 'runs'
  | 'checks'
  | 'works'
  | 'plan'
  | 'signoff';

export interface Lab {
  readonly question: string;
  /** The most characters that a post by the person may have. Added after version 1. */
  readonly postLimit?: number;
  /** The most characters that the line of a sign-off may have. Added after version 1. */
  readonly signoffLimit?: number;
  readonly startedAt: string;
  /** False: this process only shows the lab, and the project's owner runs its agents. */
  readonly agentsHere: boolean;
  readonly paused: {
    readonly at: string;
    /** `deadline`: the time budget ended. */
    readonly reason: 'person' | 'deadline';
  } | null;
  readonly budget: { readonly hours: number; readonly deadline: string } | null;
  readonly money: Money;
  /** Calls that wait for the person, oldest first. */
  readonly needsYou: readonly Call[];
  /** The newest calls that the person answered or that ended, newest first. */
  readonly answered: readonly Call[];
  readonly directions: readonly Direction[];
  /**
   * The lab's directions counted over all of them, also those that the
   * snapshot leaves out. Added after version 1.
   */
  readonly directionCounts?: DirectionCounts;
  /** The agents of the directions, then the checkers. */
  readonly agents: readonly Agent[];
  /**
   * The agent that opened the lab: it plans it, and changes the plan later.
   * Null when no agent plans the lab. Before the plan, its open scope calls
   * are its questions to the person. Added after version 1.
   */
  readonly planner?: string | null;
  readonly plan: Plan | null;
  /** The newest posts, oldest first. `GET /api/v1/board?before=` pages back. */
  readonly board: BoardPage;
  /** Posts that an objection disputes and no check settled yet. */
  readonly disputes: readonly Dispute[];
  /** The newest runs, oldest first. */
  readonly runs: readonly Run[];
  /** The newest checks, oldest first. */
  readonly checks: readonly CheckItem[];
  /**
   * The person's sign-off, or null before one. A snapshot keeps it at every
   * size, with the directions that the snapshot keeps. An older server could
   * leave it out of a large lab: it then named `signoff` in `omitted`.
   */
  readonly signoff: Signoff | null;
  /** Lab actions that still run in the background, and ones that failed there. */
  readonly works: readonly Work[];
  /** The person was away: when they left, and the two costs then. */
  readonly away: Away | null;
  /** How many items each cut list left out. A list that the snapshot did not cut is not named. */
  readonly omitted: Readonly<Partial<Record<LabList, number>>>;
  /** What desktop notifications follow, uncut at every level. Added after version 1. */
  readonly notify?: NotifyFeed;
}

/**
 * The IDs of the events that a desktop notification can tell: each call that
 * waits for the person and each settled direction. No level of the snapshot
 * cuts these lists, so a page can tell a new event from an old one that a
 * smaller snapshot left out. Each list holds at most the newest 300.
 */
export interface NotifyFeed {
  /** The calls that wait for the person, as in `needsYou`. */
  readonly calls: readonly string[];
  /** The directions that hold up. */
  readonly holdsUp: readonly string[];
  /** The directions that are ruled out. */
  readonly ruledOut: readonly string[];
}

export interface Money {
  /** Claude Code's cost estimates of the lab's sessions, added up. Codex reports none. */
  readonly plansUsd: number;
  /** What the lab's GPU pods cost so far. */
  readonly gpuUsd: number;
  /** The project's GPU spend limit, or null when none is set. */
  readonly gpuLimitUsd: number | null;
  /**
   * What all of the person's projects spent on GPU pods this calendar month,
   * and their monthly limit. Absent: no monthly limit, or Verifold has not
   * read it yet. Added after version 1.
   */
  readonly month?: { readonly spentUsd: number; readonly limitUsd: number };
}

export interface Asker {
  readonly agent: string;
  readonly handle: string;
  readonly direction: string | null;
  readonly why: string;
}

/**
 * What an option does when the person picks it. A pod lists how many pod
 * secrets it gets, never their names, and how many of those this computer
 * does not store yet (null when Verifold cannot tell). A pod cannot start
 * until each one is stored in Compute.
 */
export type Effect =
  | {
      readonly type: 'pod';
      readonly gpu: string;
      readonly hours: number;
      readonly secrets: number;
      /** Added after version 1: absent from an older server. */
      readonly missing?: number | null;
    }
  | { readonly type: 'hours'; readonly hours: number }
  | {
      readonly type: 'open';
      readonly title: string;
      readonly harness: Harness;
      readonly bar: string;
    }
  | { readonly type: 'stop'; readonly direction: string }
  | { readonly type: 'domains'; readonly domains: readonly string[] };

export interface CallOption {
  readonly label: string;
  /** One line on what the option means. Added after version 1. */
  readonly detail?: string;
  readonly usd: number | null;
  readonly minutes: number | null;
  readonly effect: Effect | null;
}

/** A question for the person: cost, scope, access, or go. */
export interface Call {
  readonly id: string;
  readonly at: string;
  readonly kind: 'cost' | 'scope' | 'access' | 'go';
  readonly question: string;
  readonly why: string;
  /** The agents that asked, the first asker first. Empty when Verifold asks. */
  readonly askers: readonly Asker[];
  /** Verifold asks at the end of the time budget. Only an option can answer it. */
  readonly byVerifold: boolean;
  readonly options: readonly CallOption[];
  /** The option that the agents advise, or null. */
  readonly pick: number | null;
  /** How long the person can undo an answer, in minutes. 0: an answer has no undo. Added after version 1. */
  readonly undoMinutes?: number;
  /** The most characters that an answer in the person's own words may have. Added after version 1. */
  readonly wordsLimit?: number;
  /**
   * The answer is saved and Verifold applies its option now, for example a
   * pod starts. `undoUntil` is set once that is done. Added after version 1.
   */
  readonly applying?: boolean;
  readonly state: 'open' | 'answered' | 'undoing' | 'withdrawn';
  readonly answer: { readonly option: number; readonly at: string } | null;
  /** The person's answer in their own words. */
  readonly words: string | null;
  /** Until then the person can undo the answer. */
  readonly undoUntil: string | null;
  /** Why it was withdrawn, or what Verifold did. */
  readonly note: string | null;
  /** The board post of the call. Replies to it go in its thread. */
  readonly post: string | null;
  /** The facts behind the call, as the agent that asked checked them. Added after version 1. */
  readonly facts?: readonly Fact[];
}

export type Verdict = 'open' | 'leading' | 'holds-up' | 'ruled-out';

/** How many directions a lab has, and how many of them hold up, are ruled out, or are still open. */
export interface DirectionCounts {
  readonly total: number;
  readonly holdsUp: number;
  readonly ruledOut: number;
  /** Open, with no verdict or with a disputed one. */
  readonly open: number;
}

export interface Direction {
  readonly id: string;
  readonly title: string;
  /** What makes it hold up, in plain words. */
  readonly bar: string | null;
  /** The repeat runs that the bar needs. */
  readonly runs: number | null;
  /** The spread between repeat runs that counts as noise. */
  readonly noise: string | null;
  readonly buildsOn: readonly {
    readonly text: string;
    readonly known: boolean;
  }[];
  readonly state: 'open' | 'stopped' | 'closed';
  readonly verdict: Verdict;
  /** A post of the direction has an objection that no check settled yet. */
  readonly disputed: boolean;
  readonly evidence: {
    readonly text: string;
    readonly post: string;
    readonly run: string | null;
  } | null;
  /** The agent that owns it. */
  readonly agent: string;
  /** `person`, or the agent that opened it. */
  readonly openedBy: string;
  readonly openedAt: string;
  readonly stoppedAt: string | null;
  /** The newest commit of its folder. */
  readonly head: string;
  /**
   * The files that the person brought into the project folder from it: how
   * many, and when the newest came in. Null when none came in. Added after
   * version 1.
   */
  readonly brought?: { readonly files: number; readonly lastAt: string } | null;
}

/** What a turn's tool calls did, by kind. */
export interface StepCounts {
  readonly search: number;
  readonly page: number;
  readonly read: number;
  readonly command: number;
  readonly edit: number;
  readonly run: number;
  readonly post: number;
  readonly helper: number;
  readonly other: number;
}

/** One turn of an agent, folded. `GET /api/v1/agents/:agent/turns/:turn` sends its steps. */
export interface Turn {
  readonly id: string;
  readonly startedAt: string;
  /** Null while the turn runs. */
  readonly endedAt: string | null;
  /**
   * Grows whenever anything in the turn changes: a step starts or ends, its
   * output grows, or text arrives. Added after version 1, with the step
   * reads' `limit` and `tools` (see `TurnDetail`).
   */
  readonly rev?: number;
  readonly counts: StepCounts;
  /** The agent's last message in the turn. */
  readonly message: Text | null;
  /** The board posts that the turn's tool calls wrote, oldest first. Added after version 1. */
  readonly posts?: readonly string[];
  /** The runs that the turn's tool calls started, oldest first. Added after version 1. */
  readonly runs?: readonly string[];
  /**
   * Some of `posts` and `runs` were matched by time, not by tool call: the
   * agent's posts and runs from while the turn ran. This happens when the
   * harness names its calls in a way that the records do not carry. Added
   * after version 1.
   */
  readonly proofByTime?: boolean;
}

export interface TurnPage {
  /** Oldest first. */
  readonly turns: readonly Turn[];
  /** Older turns exist. Ask again with `before` set to the first turn's ID. */
  readonly more: boolean;
}

/**
 * One line about an agent now. It comes from harness events, never from the
 * model's own words. `since`: when the step or the wait began.
 */
export interface Live {
  readonly state: 'working' | 'waiting' | 'idle' | 'ended';
  readonly text: string;
  readonly since: string | null;
}

export type AgentStatus =
  | 'plan'
  | 'starting'
  | 'working'
  | 'terminal'
  | 'idle'
  | 'slot'
  | 'usage'
  | 'turns'
  | 'paused'
  | 'stopped'
  | 'closed'
  | 'crashed'
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'dropped';

/** A direction's agent or a checker. */
export interface Agent {
  readonly id: string;
  readonly handle: string;
  readonly harness: Harness;
  /** The model that the harness reported, or else the one Verifold asked for. */
  readonly model: string | null;
  /** The direction that it owns. Null for a checker. */
  readonly direction: string | null;
  /** The check that it runs. Null for a direction's agent. */
  readonly check: string | null;
  readonly status: AgentStatus;
  /** When a wait ends. */
  readonly until: string | null;
  readonly live: Live;
  /** Its newest turns. */
  readonly turns: TurnPage;
  /** Claude Code's cost estimate of its sessions. Null for Codex. */
  readonly spendUsd: number | null;
}

/** What a step of a turn is. A tool call has a `kind`. */
export type StepType = 'request' | 'text' | 'thinking' | 'tool' | 'note';

export type StepKind = keyof StepCounts;

export interface Step {
  /** Its place in the turn, from 0. */
  readonly index: number;
  readonly id: string;
  /** The tool call that started a helper agent, for the helper's steps. */
  readonly parent: string | null;
  readonly type: StepType;
  readonly kind: StepKind | null;
  /** The step in plain words, such as "Running python probe.py". */
  readonly words: string;
  /** The tool's own one line: the command, path, or query. */
  readonly title: string | null;
  readonly status: 'running' | 'done' | 'failed' | null;
  readonly at: string;
  /** When the step ended. Null while it runs, and for steps that do not run. */
  readonly endedAt: string | null;
  /** A tool call's input, from its start. */
  readonly input: Text | null;
  /** The end of a tool call's output. */
  readonly output: Text | null;
  /** The words of a message, a thought, a request, or a note. */
  readonly text: Text | null;
}

/**
 * `GET /api/v1/agents/:agent/turns/:turn`: the turn's newest steps, or with
 * `?before=<index>` the steps before that one. A page holds at most 200
 * steps and about 256 KB. `?limit=<n>` (1 to 200) asks for fewer steps, and
 * `?tools=1` for tool calls only, as a fold's short list needs. Both were
 * added after version 1: a server that takes them sends `Turn.rev`, and an
 * older one answers 404 to them.
 */
export interface TurnDetail {
  readonly turn: Turn;
  /** Oldest first. */
  readonly steps: readonly Step[];
  /** Older steps exist (with `tools=1`: older tool calls). Ask again with `before` set to the first step's index. */
  readonly more: boolean;
}

export type PostKind =
  | 'plan'
  | 'claim'
  | 'evidence'
  | 'objection'
  | 'question'
  | 'rerun'
  | 'ruled-out'
  | 'status';

/** The proof that a post points to. A path is a path in the direction's folder. */
export type Proof =
  | { readonly type: 'run'; readonly run: string }
  | {
      readonly type: 'file' | 'figure';
      readonly direction: string | null;
      readonly path: string;
      readonly commit: string;
      readonly bytes: number;
    }
  | {
      readonly type: 'diff';
      readonly direction: string | null;
      readonly from: string;
      readonly to: string;
      readonly paths: readonly string[];
    };

export interface Post {
  readonly id: string;
  readonly at: string;
  /** `person`, `verifold`, or an agent ID. */
  readonly author: string;
  /** The agent's handle, such as claude-2. Null for the person and Verifold. */
  readonly handle: string | null;
  readonly harness: Harness | null;
  readonly kind: PostKind;
  readonly direction: string | null;
  readonly text: string;
  readonly replyTo: string | null;
  /** Agent IDs, `person`, or `all`. */
  readonly mentions: readonly string[];
  readonly proof: readonly Proof[];
}

export interface BoardPage {
  /** Oldest first. */
  readonly posts: readonly Post[];
  /** Older posts exist. Ask again with `before` set to the first post's ID. */
  readonly more: boolean;
}

export interface Dispute {
  readonly post: string;
  readonly objections: readonly string[];
  /** The newest check of the post, or null. */
  readonly check: string | null;
}

/** A fact that changes over time and that a plan or a call rests on. No source: it is unverified. */
export interface Fact {
  readonly claim: string;
  readonly source: string | null;
  readonly sourceDate: string | null;
  /** When the plan or the call that listed it was posted. */
  readonly listedAt: string;
}

export interface Plan {
  readonly post: string;
  readonly at: string;
  /** How the planner reads the question. */
  readonly reading: string;
  readonly cost: string;
  /** The plan's directions, in its order. */
  readonly directions: readonly string[];
  readonly facts: readonly Fact[];
  /** 1 for the first plan. Absent for a plan from before versions. Added after version 1. */
  readonly version?: number;
  /** The plan post before this one, or null. Added after version 1. */
  readonly previous?: string | null;
  /** What the planner says changed from the plan before, and why, or null. Added after version 1. */
  readonly changed?: string | null;
}

export interface Run {
  readonly id: string;
  readonly agent: string;
  readonly direction: string;
  readonly status:
    | 'queued'
    | 'running'
    | 'done'
    | 'failed'
    | 'timed-out'
    | 'cancelled'
    | 'interrupted';
  readonly command: string;
  readonly why: string;
  readonly where: 'local' | { readonly pod: string; readonly gpu: string };
  readonly commit: string;
  readonly exitCode: number | null;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** A metric whose value is not a finite number has null. */
  readonly metrics: Readonly<Record<string, number | null>>;
  /** What else happened, such as a start that failed or an output that was not there. */
  readonly note: string | null;
}

/** A check of a post that cites a run, by a fresh agent of the other harness. */
export interface CheckItem {
  readonly id: string;
  /** The post that it tests. */
  readonly post: string;
  readonly direction: string;
  readonly run: string;
  readonly harness: Harness;
  readonly agent: string;
  readonly handle: string;
  readonly sameHarness: boolean;
  /** False: the checker could read the lab's records. */
  readonly blind: boolean;
  readonly state: 'queued' | 'running' | 'done' | 'failed' | 'dropped';
  readonly outcome: 'holds' | 'fails' | 'differs' | null;
  readonly method: 'rerun' | 'code-read' | null;
  /** The checker's rerun post. */
  readonly result: string | null;
  readonly note: string | null;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export interface Signoff {
  readonly at: string;
  readonly note: string | null;
  readonly directions: readonly {
    readonly id: string;
    readonly verdict: Verdict;
    readonly commit: string;
    readonly check: string | null;
  }[];
}

export interface Work {
  /** The action, such as lab-direction-add. */
  readonly action: string;
  readonly label: string;
  readonly at: string;
  /** Why the action failed after Verifold accepted it, or null while it runs. */
  readonly error: string | null;
  /** The call that an answer or undo was for. Added after version 1. */
  readonly call?: string;
  /** The option that an answer picked. Added after version 1. */
  readonly option?: number;
  /** The direction that the action is for, such as a bring-in's. Added after version 1. */
  readonly direction?: string;
}

export interface Away {
  readonly since: string;
  readonly spentThen: { readonly plansUsd: number; readonly gpuUsd: number };
  /** What changed since then, as the desk's Home says it. Added after version 1. */
  readonly news?: AwayNews;
}

/** A direction with news since the person left. */
export interface AwayLine {
  readonly direction: string;
  readonly title: string;
  /** The mark of its row: its verdict, an open dispute, or `new` for a direction opened meanwhile that is still open. */
  readonly mark: Verdict | 'disputed' | 'new';
  /** What changed, in words, such as "Holds up (acc 0.7). 2 new posts." */
  readonly said: string;
}

/** What changed while the person was away. */
export interface AwayNews {
  /** The directions with news, the most important first: a dispute first, then the most settled. */
  readonly lines: readonly AwayLine[];
  /** Directions with news that `lines` leaves out. */
  readonly moreLines: number;
  /** What came, such as "4 posts, 3 runs ended (1 failed: r-7), 1 call for you", or "" when nothing came. */
  readonly counts: string;
  /** What the lab spent since then, such as "Spent since then: ≈$1.20 (Claude Code ≈$0.70, GPU $0.50).", or "" under a cent. */
  readonly cost: string;
}

/** A part of a search hit's text: plain, or a match of the search's words. */
export interface SnippetPart {
  readonly text: string;
  readonly mark: boolean;
}

/** A post, run, or call that a search found. */
export type SearchHit =
  | {
      readonly type: 'post';
      readonly id: string;
      readonly at: string;
      readonly kind: PostKind;
      /** The kind in words, such as "Claim", or "Message" for the person's question. */
      readonly label: string;
      /** "You", "Verifold", or an agent's handle. */
      readonly author: string;
      readonly direction: string | null;
      /** The text on one line around its first match. */
      readonly snippet: readonly SnippetPart[];
    }
  | {
      readonly type: 'run';
      readonly id: string;
      readonly at: string;
      readonly author: string;
      readonly direction: string;
      /** Where the run stands, such as "exit 0 in 6 min" or "running". */
      readonly summary: string;
      readonly snippet: readonly SnippetPart[];
    }
  | {
      readonly type: 'call';
      readonly id: string;
      readonly at: string;
      /** The kind in words, such as "Cost call". */
      readonly label: string;
      readonly author: string;
      readonly state: Call['state'];
      /** Where it stands in words, such as "waits for you" or what the person chose. */
      readonly summary: string;
      readonly question: string;
      /**
       * The person's answer: the option that they chose and when, or their
       * own words, which the lab does not time. Null before an answer.
       */
      readonly answer:
        | { readonly option: string; readonly at: string }
        | { readonly words: string }
        | null;
      /** Why it was withdrawn, or what Verifold did. */
      readonly note: string | null;
      readonly snippet: readonly SnippetPart[];
    };

/** The most characters of a search: the app's and the desk's search boxes, and `GET /api/v1/search`. */
export const searchQueryLimit = 100;

/**
 * `GET /api/v1/search?q=`: the lab's search, as the desk's panel runs it.
 * Each word must match, in any case. Added after version 1.
 */
export interface SearchResult {
  readonly q: string;
  /** What to type, that nothing matched, or how many hits. */
  readonly note: string;
  /** The hits in all. `hits` holds at most the newest 50. */
  readonly total: number;
  /** The newest first. */
  readonly hits: readonly SearchHit[];
}

/**
 * A file that a direction changed, as a bring-in shows it. Its path is in
 * the direction's folder, and the same path in the project folder is where
 * it comes in.
 */
export interface BringFile {
  readonly path: string;
  readonly change: 'added' | 'modified' | 'deleted';
  readonly bytes: number;
  /** Ticked first: it can come in, nothing ticks it off, and it did not come in already. */
  readonly ticked: boolean;
  /** Why it cannot come in, such as Verifold's own records, or null. */
  readonly out: string | null;
  /** Why it is not ticked first, such as project memory or a file that runs code, or null. */
  readonly why: string | null;
  /** When it came in from this direction with this content, or null. */
  readonly since: string | null;
  /** It can run code through the person's tools, such as a Git hook or an editor task. */
  readonly code: boolean;
}

/**
 * What a bring-in of a direction can copy: its files at the commit that the
 * person looked at (`lab-bring-look`). A bring-in copies that commit, also
 * when the agent works on.
 */
export interface BringList {
  readonly direction: string;
  /** The direction's branch, or its folder when it has none. */
  readonly branch: string;
  /** The commit that the person looked at. `lab-bring` names it. */
  readonly commit: string;
  /** The agent worked when the person looked: the files are those of its last turn. */
  readonly working: boolean;
  /** The direction has newer work than this commit. */
  readonly newer: boolean;
  /** Files of the folder that the commit leaves out, and why. */
  readonly left: readonly { readonly path: string; readonly why: string }[];
  /** Files of `left` that the list leaves out past its bound. */
  readonly leftOmitted: number;
  /** By path. */
  readonly files: readonly BringFile[];
  /** Files that the list leaves out past its bound. */
  readonly omitted: number;
}

/** One bring-in of a direction: when, at which commit, and the files that keep it as their base. */
export interface BringGroup {
  readonly at: string;
  readonly commit: string;
  readonly paths: readonly string[];
  /** Paths that the group leaves out past its bound. */
  readonly more: number;
}

/**
 * `GET /api/v1/directions/:direction/bring`. `list` is null until the person
 * asks Verifold to take the direction's newest work (`lab-bring-look`).
 * `error`: Verifold could not read the files. Added after version 1.
 */
export interface BringRead {
  readonly list: BringList | null;
  readonly error: string | null;
  /** The direction's bring-ins so far, oldest first. */
  readonly history: readonly BringGroup[];
}

/**
 * `GET /api/v1/directions/:direction/bring/diff?file=<path>&commit=<commit>`:
 * one file's changes since the direction started, at the commit of a
 * bring-in. Added after version 1.
 */
export interface FileDiff {
  readonly text: string;
  /** Verifold cut the diff. */
  readonly trimmed: boolean;
  readonly commit: string;
}

/**
 * `GET /api/v1/runs/:id`: a run in full, with the files that Verifold kept
 * from it and the end of its log. Added after version 1.
 */
export interface RunDetail {
  readonly run: Run;
  /** The handle of the agent that started it, such as claude-2. */
  readonly handle: string | null;
  readonly harness: Harness;
  /** The most minutes that it may run. */
  readonly minutes: number;
  /** The files that Verifold kept from the run, in `.verifold/lab/runs/<id>/outputs/`. */
  readonly outputs: readonly {
    readonly path: string;
    readonly bytes: number;
  }[];
  /** Kept files that `outputs` leaves out. */
  readonly moreOutputs: number;
  /** The end of its log, or null before the run wrote one. */
  readonly log: {
    readonly text: string;
    /** The size of the whole log. */
    readonly bytes: number;
    /** `text` is only the end of the log. */
    readonly partial: boolean;
  } | null;
  /** The person can cancel it here: it waits or runs, and this Verifold runs the lab's agents. */
  readonly cancelable: boolean;
}

/**
 * `GET /api/v1/directions/:direction/diff`: what a direction's folder
 * changed since it started, file by file, at its newest commit. With
 * `proof=p-12.0`, the diff that a post cites instead: its commits and its
 * files. With `file=<path>`, also that file's diff, which must be one of the
 * files. Added after version 1.
 */
export interface DirectionDiff {
  readonly from: string;
  readonly to: string;
  readonly files: readonly {
    readonly path: string;
    readonly change: 'added' | 'modified' | 'deleted';
    /** A regular file. A symbolic link or a submodule has no diff text. */
    readonly regular: boolean;
  }[];
  /** Files that `files` leaves out. */
  readonly moreFiles: number;
  /** The diff of the file asked for. */
  readonly diff: {
    readonly path: string;
    readonly text: string;
    readonly trimmed: boolean;
  } | null;
}

/**
 * `GET /api/v1/posts/:id`: a post and the replies below it at any depth,
 * oldest first, as the lab's agents read a thread. A search hit for a post
 * that the snapshot's board leaves out opens it. Added after version 1.
 */
export interface PostThread {
  /** The post first, then at most 49 replies. */
  readonly posts: readonly Post[];
  /** More replies exist than `posts` holds. */
  readonly more: boolean;
}

/** A step of the first run. */
export type SetupStep = 'agents' | 'about' | 'skills' | 'money';

/**
 * `GET /api/v1/setup`: the first run, which the app also opens later to
 * change the profile. Each step saves on its own. Added after version 1.
 */
export interface SetupView {
  /** Each step: `done`, `skipped`, or null when the person never saw it. An older server has no `skills`. */
  readonly steps: Readonly<
    Record<Exclude<SetupStep, 'skills'>, 'done' | 'skipped' | null> &
      Partial<Record<'skills', 'done' | 'skipped' | null>>
  >;
  readonly agents: SetupAgents;
  readonly about: SetupAbout;
  /** The Skills step. Added after version 1. */
  readonly skills?: SetupSkills;
  readonly money: SetupMoney;
}

/** What a skill can run, from its files, not from its own text. */
export interface SkillRuns {
  /** Script languages, with how many files of each. */
  readonly scripts: readonly {
    readonly language: string;
    readonly files: number;
  }[];
  /** Files with the executable mode. */
  readonly executables: number;
  /** Install and download commands that its files name, such as `pip install` or `curl`. */
  readonly installs: readonly string[];
  /** Up to 5 web hosts that its files name. */
  readonly hosts: readonly string[];
}

/** A skill that the search offers. */
export interface SkillCard {
  /** The same for each version of the skill. */
  readonly id: string;
  readonly name: string;
  /** One plain line on what it does. */
  readonly what: string;
  /** `owner/repo`. */
  readonly repo: string;
  readonly commit: string;
  /** The skill's folder in the repository. */
  readonly path: string;
  /** When the folder last changed. */
  readonly updated: string | null;
  readonly license: string | null;
  readonly runs: SkillRuns;
  /** `added`: this version is added. `update`: an older version is added. */
  readonly state: 'new' | 'added' | 'update';
}

/** A skill that the person added, pinned to its commit. */
export interface AddedSkill {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  readonly commit: string;
  readonly path: string;
  readonly addedAt: string;
}

export interface SetupSkills {
  /** Verifold reads the catalogs (`search`) or adds a skill (`add`) now. */
  readonly busy: 'search' | 'add' | null;
  /** The last search. Null before one. */
  readonly search: {
    readonly at: string;
    readonly catalogs: readonly {
      readonly repo: string;
      readonly commit: string | null;
      readonly problem: string | null;
    }[];
    /** The harness that picked the cards. Null: Verifold matched them to the profile. */
    readonly picker: Harness | null;
  } | null;
  readonly cards: readonly SkillCard[];
  readonly added: readonly AddedSkill[];
  /** No profile yet: the search needs the "About you" step. */
  readonly needsProfile: boolean;
  /** Why the last search, add, or removal failed. */
  readonly problem: string | null;
}

export interface SetupAgents {
  /** Verifold looks for the harnesses now. Ask again in a moment. */
  readonly checking: boolean;
  /** Claude Code, then Codex. Empty before the first check ends. */
  readonly tools: readonly AgentTool[];
}

/** A harness on this computer. Verifold reads no account fields, such as the email. */
export interface AgentTool {
  readonly harness: Harness;
  readonly installed: boolean;
  readonly version: string | null;
  /** Null: Verifold could not tell. */
  readonly signedIn: boolean | null;
  /** Claude Code's plan, such as `max`. */
  readonly plan: string | null;
  /** The person uses it for research. */
  readonly use: boolean;
  /** The model picked for it. Null: the harness's own default. */
  readonly model: string | null;
  /** The models to offer, Verifold's pick first. */
  readonly models: readonly { readonly id: string; readonly label: string }[];
}

/** One line of the "About you" conversation. */
export interface ChatLine {
  /** `verifold`: Verifold's own question. A harness: its question. */
  readonly from: 'verifold' | 'you' | Harness;
  readonly text: string;
  /** Answers that the asker suggests. */
  readonly suggestions: readonly string[];
  /** `talk`: the question asks how agents should write to the person. */
  readonly asks?: 'talk';
}

/** The profile card. Each field can be empty. */
export interface ProfileCard {
  readonly workOn: string;
  readonly explore: string;
  readonly talk: string;
}

export interface SetupAbout {
  readonly lines: readonly ChatLine[];
  /** The card to review: the draft, or the saved one. Null before either. */
  readonly card: ProfileCard | null;
  /** What the profile file holds now: a card, text in free form, or nothing. */
  readonly saved: 'card' | 'text' | null;
  /** The text in free form, when `saved` is `text`. */
  readonly text: string | null;
  /** The harness that asks and drafts. Null: none is signed in, so Verifold asks. */
  readonly harness: Harness | null;
  /** When the harness started its reply. Null: it does not work now. */
  readonly busy: string | null;
  /** Why the last reply failed. */
  readonly error: string | null;
  /** The most characters of an answer, and of each field of the card. */
  readonly limits: {
    readonly answer: number;
    readonly workOn: number;
    readonly explore: number;
    readonly talk: number;
  };
}

/** The GPU limits for new projects. `limitUsd` null: pods are off. */
export interface MoneyLimits {
  readonly limitUsd: number | null;
  readonly maxUsdPerHour: number;
  readonly maxHoursPerLease: number;
  readonly idleMinutes: number;
  readonly maxRunningPods: 1 | 2;
  /** RunPod GPU type IDs that agents may rent. */
  readonly gpuTypes: readonly string[];
  /** What all projects together may spend in one calendar month. Null: no monthly limit. Added after version 1. */
  readonly monthUsd?: number | null;
}

/** A GPU type with RunPod's Secure Cloud list price. */
export interface GpuPrice {
  readonly id: string;
  readonly name: string;
  readonly memoryGb: number;
  readonly usdPerHour: number;
}

export interface SetupMoney {
  /** The stored RunPod key, without the key. */
  readonly key: {
    readonly last4: string;
    readonly place: 'keychain' | 'secret-service' | 'file';
    /** The last check with RunPod failed, and why. */
    readonly problem: string | null;
  } | null;
  /** This computer has a keyring. Without one, a key goes into a private file. */
  readonly keyring: boolean;
  /** Common GPUs at RunPod's list prices, and when Verifold read them. Null before a read. */
  readonly prices: {
    readonly at: string;
    readonly gpus: readonly GpuPrice[];
  } | null;
  /** Verifold reads the prices now. */
  readonly reading: boolean;
  /** Why the last read of the prices failed. */
  readonly problem: string | null;
  /** The saved limits, or the defaults before a save. */
  readonly limits: MoneyLimits;
  /** Why the saved limits are not valid. The defaults show until a save replaces them. */
  readonly unreadable?: string | null;
  /**
   * What all projects spent on GPU pods this calendar month. `problem`: why
   * Verifold cannot tell it, or counts a last known value. Added after
   * version 1.
   */
  readonly month?: {
    readonly spentUsd: number;
    readonly problem?: string | null;
  };
}

/**
 * `POST /api/v1/actions/:name`: the body of each action. The server runs the
 * operation that the desk runs for the same action, with the same checks.
 * `key`: a random 32-character hex string; the same key within a minute
 * gets the same answer and runs nothing again.
 */
export interface ActionBodies {
  'lab-start': {
    readonly question: string;
    readonly hours?: number;
    readonly key?: string;
  };
  'lab-post': {
    readonly text: string;
    readonly kind?: PostKind;
    readonly direction?: string;
    readonly replyTo?: string;
    readonly key?: string;
  };
  'lab-call-answer': {
    readonly call: string;
    readonly option: number;
    readonly key?: string;
  };
  'lab-call-words': {
    readonly call: string;
    readonly text: string;
    readonly key?: string;
  };
  'lab-call-undo': { readonly call: string; readonly key?: string };
  'lab-pause': { readonly key?: string };
  'lab-resume': { readonly key?: string };
  'lab-budget': { readonly hours: number; readonly key?: string };
  'lab-direction-add': {
    readonly title: string;
    readonly harness: Harness;
    readonly bar?: string;
    readonly key?: string;
  };
  'lab-direction-stop': { readonly direction: string; readonly key?: string };
  'lab-agent-restart': { readonly agent: string; readonly key?: string };
  'lab-run-cancel': { readonly run: string; readonly key?: string };
  'lab-signoff': { readonly note?: string; readonly key?: string };
  /** Take a direction's newest work, so a bring-in shows exactly the files that come in. Added after version 1. */
  'lab-bring-look': { readonly direction: string; readonly key?: string };
  /** Copy ticked files of a direction, at the commit that the person looked at, into the project folder. Added after version 1. */
  'lab-bring': {
    readonly direction: string;
    readonly commit: string;
    readonly files: readonly string[];
    readonly key?: string;
  };
  'lab-dismiss': Record<string, never>;
  'lab-away-dismiss': Record<string, never>;
  /**
   * The person looks at the lab now. A look after 30 minutes or more away
   * starts a time away, which the snapshot's `away` shows until the person
   * dismisses it. Added after version 1.
   */
  'lab-look': Record<string, never>;
  /** The first run's actions, added after version 1. Save the agents step. */
  'setup-agents': {
    readonly claude: { readonly use: boolean; readonly model?: string };
    readonly codex: { readonly use: boolean; readonly model?: string };
    readonly key?: string;
  };
  /** Look for the harnesses again. */
  'setup-check': { readonly key?: string };
  /**
   * The person's answer, or, once a card is shown, a note that changes it.
   * `card`: the card as the person edited it, which the note then changes.
   */
  'setup-say': {
    readonly text: string;
    readonly card?: ProfileCard;
    readonly key?: string;
  };
  /** Ask the harness again after a failed reply. */
  'setup-retry': { readonly key?: string };
  /** Fill the card from the answers so far, without the harness. */
  'setup-fill': { readonly key?: string };
  /** Start the conversation again. The saved profile stays until a new one is saved. */
  'setup-restart': { readonly key?: string };
  /** Save the card to the profile, or keep the profile in free form as it is. */
  'setup-about':
    | { readonly card: ProfileCard; readonly key?: string }
    | { readonly keep: true; readonly key?: string };
  /** Check a RunPod key with RunPod, then store it outside every project. No answer holds it. */
  'setup-key': {
    readonly runpodKey: string;
    /** Keep it in a private file instead of the keyring. */
    readonly file?: boolean;
    readonly key?: string;
  };
  /** Read RunPod's prices again. */
  'setup-prices': { readonly key?: string };
  /** Save the GPU limits for new projects. `limitUsd` null: no GPUs for now. */
  'setup-money': MoneyLimits & { readonly key?: string };
  /** Skip a step, or every step that the person did not finish. */
  'setup-skip': { readonly step: SetupStep | 'all'; readonly key?: string };
  /** Read the skill catalogs and match them to the profile. Added after version 1. */
  'setup-skills-search': { readonly key?: string };
  /** Add a skill of the last search, pinned to its commit. */
  'setup-skill-add': { readonly id: string; readonly key?: string };
  /** Remove an added skill. */
  'setup-skill-remove': { readonly id: string; readonly key?: string };
  /** Finish the Skills step. */
  'setup-skills-done': { readonly key?: string };
  /**
   * Without a project: create one for the person's question, and start its
   * lab. The settings apply to this project only. Each one that is left out
   * comes from the profile. Added after version 1.
   */
  'project-start': {
    readonly question: string;
    /** Another folder: an absolute path, or one that starts with `~/`. Without it, the folder where Verifold started. */
    readonly folder?: string;
    readonly agents?: ProjectAgents;
    /** The project's GPU limit in USD. Null: no GPUs. */
    readonly gpuUsd?: number | null;
    /** The lab's time budget, in whole hours. */
    readonly hours?: number;
    readonly key?: string;
  };
  /**
   * Answer each of the planner's open questions before the plan with its
   * pick. The planner wakes once. Added after version 1.
   */
  'lab-skip-questions': { readonly key?: string };
  /**
   * Answer the planner's questions before the plan together, each with an
   * option or in the person's own words. The planner wakes once, with every
   * answer. Added after version 1.
   */
  'lab-questions-answer': {
    readonly answers: readonly QuestionAnswer[];
    readonly key?: string;
  };
}

/** An answer to one of the planner's questions: an option, or the person's own words. */
export interface QuestionAnswer {
  readonly call: string;
  readonly option?: number;
  readonly words?: string;
}

/** A project's harnesses, the lead first, with their models. A model left out comes from the profile. */
export interface ProjectAgents {
  readonly host: Harness;
  readonly model?: string;
  readonly helper?: Harness;
  readonly helperModel?: string;
}

/**
 * `GET /api/v1/start`, while Verifold runs without a project: what the Ask
 * page needs besides the profile, which `GET /api/v1/setup` gives. Added
 * after version 1.
 */
export interface StartView {
  /** The folder where Verifold started, with the home folder as `~`. */
  readonly folder: string;
  /** The folder holds files already, so the agents may read them. */
  readonly files: boolean;
  /** The lab's time budget unless the person changes it, in hours. */
  readonly hours: number;
  /** The most hours of a time budget. */
  readonly maxHours: number;
  /** The most characters of a question. */
  readonly questionLimit: number;
  /**
   * The project's agents unless the person changes them: the profile's lead
   * and helper with the models that it saved, else the signed-in harnesses
   * on this computer. Null: none is signed in. Start sends what the page
   * shows.
   */
  readonly agents: ProjectAgents | null;
  /** The project's GPU limit unless the person changes it, in USD. Null: no GPUs. */
  readonly gpuUsd: number | null;
  /** The profile has GPU limits, so a project can have its own limit within them. */
  readonly gpuLimits: boolean;
  /** A start went through: the project starts, and this page's Verifold hands it on. */
  readonly started: boolean;
}

export type ActionName = keyof ActionBodies;

/**
 * The answer to an action. Status 200: it ran. Status 202 with `pending`: a
 * slow action goes on in the background, and a later snapshot shows how it
 * ends. Status 409 has the reason that Verifold refused it.
 */
export type ActionResult =
  | { readonly ok: true; readonly pending?: true }
  | { readonly error: string };
