/**
 * The lab's on-disk records: limits, timing, record types, ID patterns, and the
 * parsers and validators of records and of agents' tool arguments. Nothing
 * here holds state. The Lab class in ../lab.ts is the only writer of records.
 */
import type { QueuedEvent } from '../agent-loop.ts';
import {
  type Post,
  agentId,
  boardLimits,
  clip,
  commitId,
  directionId,
  object,
  postId,
  runId,
  safePath,
} from '../board.ts';
import { type HarnessName, validateModel } from '../harness.ts';
import {
  briefKinds,
  callKinds,
  callLimits,
  callNeeds,
  checkMethods,
  checkOutcomes,
  directionLimits,
  handlePattern,
  noticeKinds,
  planLimits,
  storyKinds,
  threadLimits,
  verdicts,
} from '../lab-tools.ts';
import { labShares, type LabShare } from '../lab-share.ts';
import type { LabPod } from '../compute.ts';
import type { PersonProfile } from '../agency.ts';
import { type Cause, type Lease, secretNames } from '../leases.ts';
import {
  type PodRuns,
  type RunRecord,
  type Sandbox,
  runLimits,
} from '../runs.ts';
import {
  SessionActionError,
  type SessionView,
  usdValue,
  validSessionId,
} from '../session.ts';
import { type AgentTools, validDomain } from '../session-hosts.ts';
import type { RunTeam } from '../team.ts';
import {
  type ChangedFile,
  type Workspace,
  parseWorkspace,
  projectPath,
} from '../workspaces.ts';

export const labLimits = {
  directions: planLimits.directions,
  wakeupsPerHour: 30,
  /** Lines in one digest. */
  digest: boardLimits.digest,
  /** Events and actions kept in an agent's record. */
  events: 200,
  actions: 300,
  postsPerHour: 40,
  /** Restarts of an agent whose process stopped by itself. */
  restartsPerHour: 2,
  readBytes: 64 * 1024,
  /**
   * Characters of one post's quoted text, and of one note, in a digest. With
   * at most 30 lines of each, a digest stays far below the 100,000 characters
   * that a turn takes.
   */
  digestPost: 1500,
  digestNote: 500,
  /** Characters of a whole digest message. Posts that do not fit wait for the next one. */
  digestText: 98_000,
  question: 4000,
  title: 120,
  bar: boardLimits.text,
  /**
   * Entries of the first plan of record. `low` holds at any "Agents at once".
   * A higher setting allows a first plan up to `max`, and a plan lists every
   * open direction, so a first plan has more when the person opened more.
   */
  firstPlan: { min: 2, low: 4, max: planLimits.directions },
  /** Hours of one time budget, or of one extension. */
  hours: 168,
  /** Turns in a row without a post, after which an agent's next turn asks it to post. */
  quietTurns: 6,
  /** Hours of the lab's clock that an agent worked since its last post, after which it gets asked to post, after 2 turns at least. */
  quietHours: 2,
  /** Characters of the person's note when they sign off. */
  signoff: boardLimits.text,
  /**
   * Characters of the lab's record after a bring-in, at most. The record
   * reads up to 4 MB, and the rest of it needs room too.
   */
  recordText: 2_500_000,
  /** Files of one bring-in. */
  bringFiles: 1000,
  /** Directions in a sign-off. */
  signoffDirections: 500,
};

export const labTiming = {
  /** Agent posts that arrive within this time join one wakeup. */
  debounceMs: 20_000,
  /** The next turn of an agent whose direction is open. */
  continueMs: 20_000,
  /** How often the lab starts or resumes an agent that waits. One agent starts each time. */
  tickMs: 5_000,
  /** The waits after 2, 3, and 4 or more turns in a row that gave the other agents no new commit and no post. */
  backoffMs: [10 * 60_000, 30 * 60_000, 2 * 3_600_000] as readonly number[],
  /** The wait after a start that failed. It doubles with each failure in the last hour. */
  retryMs: 30_000,
  /** One hour of the lab's clock: time budgets, agent starts, hourly limits of posts, stops and turns, and the ask to post. */
  hourMs: 3_600_000,
  /** One minute of a run's time limit. */
  minuteMs: 60_000,
  /** The time between two reads of a pod run's job. */
  podPollMs: 20_000,
  /** The time that a proposal stays open to objections. Then it becomes the decision of its thread. */
  objectionMs: threadLimits.objectionMinutes * 60_000,
  /** State changes within this time join one update of the Coordinator. */
  briefDelayMs: 3 * 60_000,
};

/** Work that a direction builds on: known work, or new in this lab. */
export interface BuildsOn {
  readonly text: string;
  readonly known: boolean;
}

export type Verdict = (typeof verdicts)[number];

/** The one line of evidence of a verdict, with the post that has the proof and the run that it cites. */
export interface Evidence {
  readonly text: string;
  readonly post: string;
  readonly run: string | null;
}

export interface Direction {
  readonly id: string;
  readonly title: string;
  /** What its agent does, as a short label. Null: none set, as in a lab from before jobs. */
  readonly job: string | null;
  /** The team of directions that it works with, as a short label. Null: none set. */
  readonly team: string | null;
  /** Its agent works on long shots, far from known work. */
  readonly longShot: boolean;
  /** What makes the direction hold up, in plain words. */
  readonly bar: string | null;
  /** The repeat runs that the bar needs, such as seeds. */
  readonly runs: number | null;
  /** The spread between repeat runs that counts as noise. */
  readonly noise: string | null;
  readonly buildsOn: readonly BuildsOn[];
  /** `person`, or the agent that opened it. */
  readonly openedBy: string;
  readonly openedAt: string;
  /** `stopped`: the person stopped it. `closed`: its agent closed it after its final verdict. */
  readonly state: 'open' | 'stopped' | 'closed';
  readonly stoppedAt: string | null;
  /** What its agent says of it now. Only its agent changes it. */
  readonly verdict: Verdict;
  readonly evidence: Evidence | null;
  /** The agent that owns the direction. */
  readonly agent: string;
  /** The direction's own copy of the project. */
  readonly workspace: Workspace;
  /** The newest commit of the folder. Other agents read its files there. */
  readonly head: string;
}

/**
 * A fact that changes over time and that a plan rests on, such as a model or
 * a GPU price. No source: the agent could not check it, so it is unverified.
 */
export interface PlanFact {
  readonly claim: string;
  readonly source: string | null;
  /** The source's date, as the agent wrote it. */
  readonly sourceDate: string | null;
  /** When the plan that gave the fact was posted. */
  readonly checkedAt: string;
}

/** The plan of record: the newest plan post of the agent that opened the lab. */
export interface PlanOfRecord {
  readonly post: string;
  readonly at: string;
  readonly reading: string;
  readonly cost: string;
  /** The directions of the plan, in its order. */
  readonly directions: readonly string[];
  readonly facts: readonly PlanFact[];
  /**
   * The plan post where the facts last changed. A later plan that lists no
   * facts, or the same ones, keeps it, so agents get each change once. A
   * plan from before this field has none: its own post stands for it.
   */
  readonly factsPost?: string;
  /** 1 for the first plan. A plan from before versions has none. */
  readonly version?: number;
  /** The plan post before this one. */
  readonly previous?: string;
  /** What the planner says changed from the plan before, and why. */
  readonly changed?: string;
}

export interface LabState {
  readonly schemaVersion: 1;
  readonly question: string;
  readonly startedAt: string;
  /** The lab is paused: no agent works until the person resumes it. */
  readonly pausedAt: string | null;
  /** `deadline`: the time budget ended. The person gives more time to resume. */
  readonly pausedFor: 'person' | 'deadline' | null;
  /** The last handle number of each harness: claude-1, codex-1, and so on. Only a lab without `roles` counts here. */
  readonly handles: Readonly<Record<HarnessName, number>>;
  /**
   * The last number of each role: agent-3, checker-1. Null: a lab from
   * before role names, which keeps its handles for each harness. See
   * names.ts.
   */
  readonly roles: {
    readonly agents: number;
    readonly checkers: number;
  } | null;
  readonly directions: readonly Direction[];
  /** How far from known work the person wants the lab to go. Null: a lab from before this choice. */
  readonly share: LabShare | null;
  /** The agent that opened the lab. It posts and changes the plan of record. */
  readonly opener: string | null;
  readonly plan: PlanOfRecord | null;
  /** After `deadline`, the lab pauses itself. */
  readonly budget: { readonly hours: number; readonly deadline: string } | null;
  /** When agents started agents, in the last 24 hours. */
  readonly agentStarts: readonly string[];
  /** The checks of claims, oldest first. */
  readonly checks: readonly Check[];
  /** The calls for the person, oldest first. */
  readonly calls: readonly Call[];
  /** The files that the person brought into the project folder, oldest first. */
  readonly brought: readonly Brought[];
  /** A bring-in that Verifold began and did not end. */
  readonly bringing: Bringing | null;
  /** The person's newest sign-off of the lab's answer. */
  readonly signoff: Signoff | null;
}

/**
 * A file that the person brought in from a direction: the commit that it
 * came from, and when. It is the file's base for the next bring-in from that
 * direction, so a later bring-in of the same file replaces it.
 */
export interface Brought {
  readonly direction: string;
  readonly path: string;
  readonly commit: string;
  readonly at: string;
}

/**
 * A bring-in that Verifold began. `checking`: Verifold compares the files
 * and writes temporary copies; the project has none of them yet. `copying`:
 * every file passed, and Verifold changes the project. After a stop in the
 * middle, the next start finishes the copy.
 */
export interface Bringing {
  readonly direction: string;
  readonly commit: string;
  readonly files: readonly string[];
  readonly at: string;
  readonly phase: 'checking' | 'copying';
}

/** The person's sign-off of the lab's answer: each direction's verdict, its newest commit, and the check behind it. */
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

/** A file that a direction changed, as a bring-in shows it. */
export interface BringFile {
  readonly path: string;
  readonly change: ChangedFile['change'];
  readonly bytes: number;
  /** Ticked first: it can come in, nothing ticks it off, and it did not come in already. */
  readonly ticked: boolean;
  /** Why it cannot come in, or null. */
  readonly out: string | null;
  /** Why it is not ticked first, such as project memory, or null. */
  readonly why: string | null;
  /** When it came in from this direction with this content, or null. */
  readonly since: string | null;
  /** It can run code through the person's tools, such as a Git hook. */
  readonly code: boolean;
}

/** A file of the folder that the commit of a look leaves out, and why. */
export interface LeftOut {
  readonly path: string;
  readonly why: string;
}

/** The files that a bring-in of a direction can copy, at the commit that the person looks at. */
export interface BringList {
  readonly direction: string;
  readonly from: string;
  readonly commit: string;
  /** The direction's newest commit when the person looked. */
  readonly head: string;
  /** The agent worked when the person looked: the files are those of its last commit. */
  readonly working: boolean;
  /** The direction has newer work than the commit that the person looks at. */
  readonly newer: boolean;
  /** Files of the folder that the commit leaves out. */
  readonly left: readonly LeftOut[];
  readonly files: readonly BringFile[];
}

export type CheckOutcome = (typeof checkOutcomes)[number];

export type CheckMethod = (typeof checkMethods)[number];

/**
 * A check: a fresh session of the other harness tests a claim that cites a
 * run, without the author's reasoning. An objection to the claim queues one,
 * and so does the direction's agent when it asks for holds-up. The checker's
 * rerun post settles the dispute, and the direction's verdict follows it.
 */
export interface Check {
  readonly id: string;
  /** The post that it tests: a claim, evidence, or rerun that cites a run. */
  readonly claim: string;
  /** The objections that it settles. */
  readonly objections: readonly string[];
  /** The direction's agent asked for holds-up on this claim. */
  readonly holdsUp: boolean;
  /** The person asked for this check. */
  readonly byPerson?: true;
  readonly direction: string;
  /** The claim's run. The checker's folder holds the files of its commit. */
  readonly run: string;
  readonly commit: string;
  readonly harness: HarnessName;
  /** The team has one harness, so a fresh session of the same harness checks. */
  readonly sameHarness: boolean;
  /** The checker: an agent ID and a handle of its own. It is no direction's agent. */
  readonly agent: string;
  readonly handle: string;
  readonly model: string | null;
  /** `dropped`: the ask for holds-up that it served no longer stands. */
  readonly state: 'queued' | 'running' | 'done' | 'failed' | 'dropped';
  readonly outcome: CheckOutcome | null;
  readonly method: CheckMethod | null;
  /** The checker's rerun post. */
  readonly result: string | null;
  /** Why it failed. */
  readonly note: string | null;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /**
   * Starts after the checker's process stopped by itself, a start failed, or
   * an owner ended without closing the lab. After one, the next stop fails it.
   */
  readonly restarts: number;
  /**
   * The minutes and turns that it used before Verifold last stopped it, as a
   * pause or a close does. Its next session gets only the rest. A restart
   * after a stop that counts starts afresh.
   */
  readonly used?: { readonly minutes: number; readonly turns: number };
  readonly session: string | null;
  /** Each start gets a new one. A tool call of an older start changes nothing. */
  readonly generation: string;
  /** The start commit of the checker's folder, `.verifold/checks/<id>`, once Verifold made it. */
  readonly start: string | null;
  /**
   * The checker's harness could not read the lab's records. False when the
   * project's path has characters that its deny rules read as patterns.
   */
  readonly blind: boolean;
  /** Claude Code's cost estimate of the checker's sessions. */
  readonly spend?: Spend;
}

/**
 * Claude Code's cost estimate of an agent's sessions, added up across their
 * processes. `seen` is the newest estimate of `session`.
 */
export interface Spend {
  readonly usd: number;
  readonly session: string;
  readonly seen: number;
}

export type CallKind = (typeof callKinds)[number];

export type CallNeed = (typeof callNeeds)[number];

/** An agent that asks a call, with the direction that it works on and why it asks. */
export interface CallAsker {
  readonly agent: string;
  readonly direction: string | null;
  readonly why: string;
}

/** What an option of a call does when the person picks it. Verifold applies it. */
export type CallEffect =
  | {
      readonly type: 'pod';
      readonly gpuType: string;
      readonly hours: number;
      readonly secrets: readonly string[];
    }
  | { readonly type: 'hours'; readonly hours: number }
  | {
      readonly type: 'open';
      readonly title: string;
      readonly harness: HarnessName;
      readonly bar: string;
    }
  | { readonly type: 'stop'; readonly direction: string }
  | { readonly type: 'domains'; readonly domains: readonly string[] }
  /** The project's limit of pods that run at once. */
  | { readonly type: 'podsAtOnce'; readonly pods: number };

export interface CallOption {
  readonly label: string;
  /** One line on what the option means. An option from before details has none. */
  readonly detail?: string;
  readonly usd: number | null;
  readonly minutes: number | null;
  readonly effect: CallEffect | null;
}

/** What an answer changed, so that an undo reverses exactly that. */
export type CallApplied =
  | { readonly type: 'pod'; readonly lease: string }
  | {
      readonly type: 'hours';
      readonly hours: number;
      /** The time budget before the answer. */
      readonly budget: LabState['budget'];
      /** The deadline that the answer set. */
      readonly deadline: string | null;
    }
  | { readonly type: 'open'; readonly direction: string }
  | { readonly type: 'stop'; readonly direction: string }
  /**
   * The shell of each agent that asked reaches the option's domains while
   * the answer stands. `agent`: the agent that asked first. Earlier builds
   * read a record only with it, and no code here reads it.
   */
  | { readonly type: 'domains'; readonly agent: string }
  /** `before`: the limit before the answer, which an undo sets again. */
  | {
      readonly type: 'podsAtOnce';
      readonly pods: number;
      readonly before: number;
    };

/**
 * A call for the person: cost, scope, access, or go. An agent asks with
 * options, its pick, and why; Verifold asks at the end of the time budget and
 * for a lab's first GPU pod. The answer applies at once, and the person can
 * undo it until `undoUntil`.
 */
export interface Call {
  readonly id: string;
  readonly at: string;
  /** The agent that asked, or `verifold`. */
  readonly by: string;
  /** The direction of the agent that asked. */
  readonly direction: string | null;
  /** Agents that asked the same thing later. The answer reaches them too, and an effect for a shell applies to theirs. */
  readonly joined: readonly CallAsker[];
  readonly kind: CallKind;
  /** What the call asks for when no option effect says it. Calls with the same need join. */
  readonly need: CallNeed | null;
  readonly question: string;
  readonly options: readonly CallOption[];
  /** The option that the agents advise. Null: Verifold asks, and advises none. */
  readonly pick: number | null;
  readonly why: string;
  readonly undoMinutes: number;
  /** Verifold's call at the end of the time budget: the deadline that ended. */
  readonly deadline: string | null;
  /**
   * `answered`: Verifold applies the answer, or applied it. `undoing`:
   * Verifold reverses it, and the call is open again after that.
   * `withdrawn`: the asker's direction ended, or the call no longer makes
   * sense.
   */
  readonly state: 'open' | 'answered' | 'undoing' | 'withdrawn';
  readonly answer: { readonly option: number; readonly at: string } | null;
  /** The person's answer in their own words instead of an option. No option applies, and it has no undo. */
  readonly words: string | null;
  /** The board post that says that the call waits for the person. Replies to the call go in its thread. */
  readonly post: string | null;
  /** Until then the person can undo the answer. Null: no undo. */
  readonly undoUntil: string | null;
  /** What the answer changed. Null with an effect: Verifold stopped while it applied it. */
  readonly applied: CallApplied | null;
  /** Why it was withdrawn, or what Verifold did. */
  readonly note: string | null;
  /** The facts behind the call that change over time, as the asker checked them. A call from before facts has none. */
  readonly facts?: readonly PlanFact[];
  /** A question of the planner before the plan: its answer's line, until the planner hears all its answers together. */
  readonly held?: string;
  /** A held line is the person's answer or undo, not only Verifold's own note. */
  readonly heldByPerson?: true;
}

export interface LabEvent {
  readonly kind:
    | 'post'
    | 'person'
    | 'restart'
    | 'quota'
    | 'continue'
    | 'run'
    | 'pod'
    | 'call'
    | 'helper'
    | 'notice';
  readonly text: string;
  /** The post that the event is about. */
  readonly post?: string;
  /** The digest shows the text whole: the answers to the planner's questions, which `heldChars` bounds. */
  readonly whole?: true;
  /** The text says when the agent's turn came. A run's end makes it old. */
  readonly timing?: true;
  /** A `call` event with the person's answer, or their undo of one. See `personal`. */
  readonly byPerson?: true;
}

export interface LabAction {
  /** The harness's call ID. A repeated call gets the same answer and changes nothing. */
  readonly key: string;
  readonly at: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly result: string;
}

export type ThreadState = 'open' | 'decided' | 'answered' | 'closed';

/** How a thread ended: what, from which post, who, and when. A closed thread shows it first. */
export interface ThreadOutcome {
  readonly text: string;
  readonly post: string;
  readonly by: string;
  readonly at: string;
}

/** A reaction from `verifold_agree`. It is no post. */
export interface Agreement {
  readonly post: string;
  readonly by: string;
  readonly at: string;
}

export interface Thread {
  /** `t-N`. */
  readonly id: string;
  /** What agents read. It comes from an agent, from Verifold, or from the person's own words. */
  readonly title: string;
  /** The Coordinator's wording for the person. Like all plain words, it reaches no agent. */
  readonly plainTitle?: string;
  readonly state: ThreadState;
  /** One line on why the thread exists. */
  readonly why: string;
  readonly direction?: string;
  /** `person`, `verifold`, or an agent ID. */
  readonly openedBy: string;
  readonly at: string;
  /** The first post. Absent until it lands. */
  readonly opening?: string;
  readonly outcome?: ThreadOutcome;
  /** Agent IDs: who posted in it, who an ask in it names, and who chose to follow. */
  readonly followers: readonly string[];
  readonly agreed: readonly Agreement[];
  /** The newest proposal that the person overturned. It and older proposals never become a decision. */
  readonly overturned?: string;
}

export type HelperState = 'running' | 'done' | 'lost';

/** A subagent of an agent's harness. `lost`: it stopped with no result. */
export interface Helper {
  /** The harness's ID of the call that started it. */
  readonly id: string;
  /** Such as `agent-3.1`. */
  readonly label: string;
  readonly title: string;
  readonly state: HelperState;
  readonly at: string;
  /** The process that it runs in. */
  readonly launch: string;
  /** Its agent heard that it stopped with no result. */
  readonly told?: true;
}

/** What a screen shows of the lab's reading. */
export interface Reading {
  /** Papers on the reading map. */
  readonly papers: number;
  /** Lookups in harness records. */
  readonly lookups: number;
  /** The last paper in harness records. */
  readonly lastPaperAt: string | null;
}

export type BriefKind = (typeof briefKinds)[number];

export type StoryKind = (typeof storyKinds)[number];

export type NoticeKind = (typeof noticeKinds)[number];

/**
 * `pending`: no check came yet. `passed`: a second session found each claim in
 * the posts. `failed`: it did not. `numbers`: a number is not in the posts, so
 * no check runs. `withheld`: this lab keeps no plain words, because the deny
 * rules cannot express its paths. Only `passed` shows the plain words.
 */
export type LineState =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'numbers'
  | 'withheld';

export interface LineCheck {
  readonly state: LineState;
  /** The harness of the session that checked it. */
  readonly by: HarnessName | null;
  /** A fresh session of the writer's own harness checked it: the team has one. */
  readonly sameHarness: boolean;
  /** What a failed check found, or the numbers that no post holds. */
  readonly problems: readonly string[];
}

/** A plain line with what it rests on. */
export interface BriefLine {
  /** `l-N`. */
  readonly id: string;
  readonly kind: BriefKind | StoryKind | 'answer';
  /** The time of its newest post. */
  readonly at: string;
  readonly plain: string;
  readonly posts: readonly string[];
  /** The harness that wrote it. Its check uses another one. */
  readonly writer: HarnessName;
  readonly check: LineCheck;
}

export interface BriefRecord {
  readonly at: string;
  /** The state of directions and threads that it covers. */
  readonly key: string;
  /** The newest post then. */
  readonly through: number;
  readonly lines: readonly BriefLine[];
}

/** How a thread went, for the person. No agent reads it. */
export interface ThreadStory {
  readonly thread: string;
  readonly at: string;
  /** The posts of the thread that its session's prompt held. A post that came later or moved in is not among them. */
  readonly posts: readonly string[];
  /** The post with the thread's outcome in that prompt. Null: it had none. */
  readonly outcome: string | null;
  readonly lines: readonly BriefLine[];
}

/** What the Coordinator told agents. Verifold wrote the words from the kind and the posts. */
export interface Notice {
  /** `n-N`. */
  readonly id: string;
  readonly at: string;
  readonly kind: NoticeKind;
  readonly posts: readonly string[];
  /** The agents that get it. */
  readonly to: readonly string[];
}

/** A question of the person. `unanswered`: its session ended with no answer. */
export interface Question {
  /** `q-N`. */
  readonly id: string;
  readonly at: string;
  readonly text: string;
  readonly state: 'waiting' | 'answered' | 'unanswered';
  readonly answer: BriefLine | null;
}

/** A session of the place, for the hourly limits. */
export interface SessionMark {
  readonly at: string;
  readonly kind: 'update' | 'check' | 'story';
}

/** What the store holds. */
export interface BriefView {
  readonly brief: BriefRecord | null;
  readonly notices: readonly Notice[];
  readonly questions: readonly Question[];
  readonly stories: readonly ThreadStory[];
  /** Newest last. */
  readonly sessions: readonly SessionMark[];
  /** Claude Code's cost estimate of the sessions. */
  readonly spend?: Spend;
}

/** The agent's own line from `verifold_status`: what it does, why, and what comes next. */
export interface StatusLine {
  readonly doing: string;
  readonly why: string;
  readonly next: string;
  readonly at: string;
}

export interface AgentRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  /** The name on the board, such as agent-3, or claude-1 in an older lab. */
  readonly handle: string;
  readonly host: HarnessName;
  readonly model: string | null;
  readonly direction: string;
  readonly startedAt: string;
  /** The person stopped the agent's direction, or the agent closed it. */
  readonly stoppedAt: string | null;
  /**
   * `crashed`: its process stopped too often by itself. The person restarts
   * it. `closed`: the agent closed its direction, and its session ends after
   * the turn.
   */
  readonly stopReason: 'person' | 'crashed' | 'closed' | null;
  /** Each start or resume of the session gets a new one. A tool call of an older one changes nothing. */
  readonly generation: string;
  readonly session: string | null;
  /** The tools that the agent's thread has. Codex keeps them for the thread's life. */
  readonly toolsVersion: number;
  /** The newest post that the agent has read, with every post before it. */
  readonly readThrough: number;
  /** Posts after `readThrough` that the agent has read already. */
  readonly seen: readonly string[];
  /** The last event that a digest carried. */
  readonly cursor: number;
  readonly wakeups: readonly string[];
  readonly events: readonly QueuedEvent<LabEvent>[];
  /** Turns in a row that gave the other agents nothing new: no post, and no file change or a commit that failed. */
  readonly idleStreak: number;
  /** Turns in a row without a post of the agent. */
  readonly quietTurns: number;
  /** The time that those turns ran, in milliseconds. Waits and pauses do not count. */
  readonly quietWork: number;
  /** The agent got asked to post in this quiet stretch. Its next post ends the stretch. */
  readonly nudged: boolean;
  /**
   * The agent closed its direction, and the close is done: its session ended
   * and its folder's last work is committed.
   */
  readonly finished: boolean;
  /** The fingerprint of the direction's folder after the last turn, ignored files too. */
  readonly folder: string | null;
  /**
   * The files with more than one link that the last commit after a turn left
   * out: a fingerprint of the set, up to 5 of their paths, how many there
   * are, and whether a prompt or digest told the agent of this set. Absent:
   * no commit after a turn yet.
   */
  readonly linked?: {
    readonly print: string;
    readonly paths: readonly string[];
    readonly count: number;
    readonly told: boolean;
  };
  /** When its process stopped by itself, recently. */
  readonly restarts: readonly string[];
  readonly actions: readonly LabAction[];
  /**
   * The last `verifold_board` read of unread posts, by its call ID. The read
   * marks posts read, so a repeated call gets this answer again.
   */
  readonly lastRead: { readonly key: string; readonly text: string } | null;
  /**
   * A plan opened its direction, and the plan is not kept yet. The agent
   * starts once it is, so its first prompt has the plan.
   */
  readonly held: boolean;
  /**
   * The agent's session has the pod tools. A Codex thread keeps the tools
   * that it started with, so a Codex agent that lacks them starts a new
   * thread when pods are on.
   */
  readonly pods: boolean;
  /**
   * The `factsPost` of the plan facts that the agent has: from its first
   * prompt, a digest, or its own plan. A plan whose facts changed after it
   * tells the agent once, in its next digest. Absent: none yet.
   */
  readonly factsPost?: string;
  /** Claude Code's cost estimate of the agent's sessions. */
  readonly spend?: Spend;
  /** Its newest `verifold_status`. Absent: none yet, or a lab from before threads. */
  readonly statusLine?: StatusLine;
}

/** What the desk shows of one direction. */
export interface DirectionView {
  readonly direction: Direction;
  readonly agent: AgentRecord;
  /**
   * `working`: a turn runs. `idle`: between turns, or parked until a post wakes
   * it. `slot`: it waits for a free agent slot. `usage`: it waits for its
   * harness's usage window. `turns`: it waits for its hourly turns. `paused`:
   * the lab is paused. `plan`: a plan opened it, and it starts once the plan
   * is kept. `closed`: its agent closed it after its final verdict.
   * `terminal`: the person holds its harness's own terminal.
   */
  readonly status:
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
    | 'crashed';
  /** When a wait ends. */
  readonly until: string | null;
  /** It has no process now, so a wake needs a free slot. */
  readonly parked?: boolean;
  /** The subagents of its harness. */
  readonly helpers?: readonly Helper[];
}

export interface LabView {
  readonly state: LabState;
  readonly directions: readonly DirectionView[];
  readonly posts: readonly Post[];
  /** The handle of each agent, such as agent-3, by agent ID. */
  readonly handles: Readonly<Record<string, string>>;
  /** Agents work in this process. False: it only shows the lab, and the person works in it with the project's owner. */
  readonly runs: boolean;
  /** The lab's runs, oldest first. */
  readonly ledger: readonly RunRecord[];
  /** The checks of claims, oldest first. */
  readonly checks: readonly Check[];
  /** USD: Claude Code's cost estimates of every agent's and checker's sessions, added up. Codex reports none. */
  readonly claudeUsd: number;
  /** The lab opens its planner now. */
  readonly openingPlanner?: boolean;
  /** The threads, oldest first. Absent or empty: a lab from before threads. */
  readonly threads?: readonly Thread[];
  /** What the lab read. Absent: a lab from before threads. */
  readonly reading?: Reading;
  /** The brief, the notices, and the person's questions. Absent: a lab from before threads. */
  readonly brief?: BriefView;
  /** Every worker slot is taken. */
  readonly slotsFull?: boolean;
}

/** The harness sessions of the lab: the project's worker slots. */
export interface LabSessions {
  readonly full: boolean;
  /** "Agents at once". Agents never start more agents than this in 24 hours. */
  readonly limit?: number;
  view(id: string): SessionView | null;
  idle(id: string): boolean;
  startAgent(input: {
    readonly host: HarnessName;
    readonly model?: string;
    readonly prompt: string;
    readonly cwd: string;
    readonly agent: string;
    readonly tools: AgentTools;
    /** A checker: more paths that it cannot read. */
    readonly denyRead?: readonly string[];
    /** The domains that its shell commands may reach. */
    readonly network?: readonly string[];
    /** It acts only through `tools`, with no shell and no file tools of its own. */
    readonly toolsOnly?: boolean;
    /** A short session beside the agents, with a window of its own in recovery. */
    readonly side?: boolean;
  }): Promise<string>;
  /** A resume takes the agent's domains and denials, also when they changed. */
  resumeAgent(
    id: string,
    tools: AgentTools,
    network?: readonly string[],
    denyRead?: readonly string[],
  ): Promise<void>;
  /** Hand an agent's live session to its harness's own terminal, between turns. */
  takeAgentTerminal(id: string, lease: string): Promise<void>;
  park(id: string): Promise<boolean>;
  continueTask(id: string, text: string): void;
  steer(id: string, text: string, done: (taken: boolean) => void): boolean;
  endTask(id: string, reason: string): void;
}

export interface LabOptions {
  readonly sessions: LabSessions;
  /**
   * The place of the Coordinator and its line check, outside "Agents at once":
   * one session at a time. Without it, a lab has no Coordinator.
   */
  readonly reserved?: Pick<
    LabSessions,
    'full' | 'view' | 'startAgent' | 'continueTask' | 'endTask'
  >;
  /** One run has one team. A lab starts only when the guard gives it the run. */
  readonly team?: RunTeam;
  readonly memory?: {
    note(who: string, text: unknown): Promise<string>;
    digest(): Promise<string>;
  };
  /** The usage windows of the harness accounts. No agent wakes into a used-up one. */
  readonly quota?: { parked(host: HarnessName): string | null };
  /**
   * The model of a new agent or checker on a harness: the project's model,
   * else the profile's, else Verifold's pick for Claude Code. Null: no model
   * is named. A Codex agent then gets the first of Verifold's preferred
   * models that its own app-server lists, else the person's own Codex model.
   */
  readonly model?: (host: HarnessName) => Promise<string | null>;
  /**
   * The person's profile, read when a prompt is built. The planner gets the
   * whole of it. Every other agent and each checker gets only how the
   * person wants agents to write to them.
   */
  readonly person?: () => Promise<PersonProfile | null>;
  /**
   * Paths that no agent, checker, or run of the lab may read, more than the
   * credential paths: a profile folder outside the default one.
   */
  readonly denyRead?: readonly string[];
  /**
   * The harnesses of the project's team, the main one first. A lab's first
   * agent runs on the main one and posts the plan of record, and a plan's
   * directions use these harnesses only. Without it, a lab starts with no
   * agent, and the person opens each direction.
   */
  readonly harnesses?: () => Promise<readonly HarnessName[]>;
  readonly progress?: (line: string) => void;
  /** The directions or their verdicts changed, so the project memory writes them. */
  readonly onChange?: () => void;
  readonly timing?: Partial<typeof labTiming>;
  /**
   * Agents start, resume, and wake. False in a process that runs one session
   * of the person and then ends: it shows the lab, and its changes wait for
   * the project's owner.
   */
  readonly runs?: boolean;
  /** The source of a draw of long shots: a number from 0 up to 1. Default: `Math.random`. */
  readonly random?: () => number;
  /** The sandbox of agents' runs. Default: this computer's. Null: local runs are refused. */
  readonly sandbox?: Sandbox | null;
  /** The project's GPU pods. Without it, agents get no pod tools, and pod runs are refused. */
  readonly compute?: LabCompute;
}

/** What the lab uses of the project's compute: its pod tools and the pod work of runs. */
export interface LabCompute {
  /** The person's limits, the budget, the leases, and the allowed GPUs, as JSON for an agent. */
  describe(): Promise<string>;
  /** Ask for a lease, and start it when it fits the limits. Returns the reply for the agent. */
  requestPod(input: {
    readonly by: 'agent';
    readonly gpu: unknown;
    readonly hours: unknown;
    readonly directions: readonly string[];
    readonly reason: string;
    readonly secrets?: unknown;
  }): Promise<string>;
  /** What a lease of lab directions can cost at most, after the checks of a request. It records nothing. */
  podCost(input: LabPod): Promise<number>;
  /** The person's limit of pods that run at once. */
  podsAtOnce(): number;
  /**
   * Set that limit, as a call's answer or its undo does. `only`: change it
   * only while it is this value. Returns the limit before, and whether it changed.
   */
  setPodsAtOnce(
    pods: number,
    only?: number,
  ): Promise<{ readonly before: number; readonly changed: boolean }>;
  /** The person picked a pod in a call: the lease starts as one that they approved. */
  startPod(input: LabPod): Promise<Lease>;
  /** A key is stored and the person set a spend limit. */
  podsOn(): boolean;
  /** A RunPod key is stored on this computer, with or without a spend limit. */
  keySaved(): boolean;
  readonly leases: {
    list(): readonly Lease[];
    get(id: unknown): Lease;
    end(id: unknown, by: Cause, reason: string): Promise<Lease>;
  };
  podRuns(): PodRuns;
}

export function fail(message: string): never {
  throw new SessionActionError(message);
}

const checkPattern = /^k-[1-9]\d{0,5}$/;

/** A check from `lab.json`, or null when it is not valid. */
function parseCheck(value: unknown): Check | null {
  const entry = object(value);
  if (!entry) return null;
  const states = ['queued', 'running', 'done', 'failed', 'dropped'] as const;
  const state = states.find((item) => item === entry.state);
  if (
    !state ||
    typeof entry.id !== 'string' ||
    !checkPattern.test(entry.id) ||
    typeof entry.claim !== 'string' ||
    !postId.test(entry.claim) ||
    typeof entry.direction !== 'string' ||
    !directionId.test(entry.direction) ||
    typeof entry.run !== 'string' ||
    !runId.test(entry.run) ||
    typeof entry.commit !== 'string' ||
    !commitId.test(entry.commit) ||
    (entry.harness !== 'claude' && entry.harness !== 'codex') ||
    typeof entry.agent !== 'string' ||
    !agentId.test(entry.agent) ||
    typeof entry.handle !== 'string' ||
    !handleId.test(entry.handle) ||
    typeof entry.queuedAt !== 'string' ||
    typeof entry.generation !== 'string'
  )
    return null;
  const model =
    typeof entry.model === 'string' && entry.model.trim() ? entry.model : null;
  try {
    validateModel(model ?? undefined);
  } catch {
    return null;
  }
  const count = (item: unknown): number =>
    Number.isSafeInteger(item) && (item as number) >= 0 ? (item as number) : 0;
  const used = object(entry.used);
  return {
    id: entry.id,
    claim: entry.claim,
    objections: Array.isArray(entry.objections)
      ? entry.objections
          .filter(
            (item): item is string =>
              typeof item === 'string' && postId.test(item),
          )
          .slice(-20)
      : [],
    holdsUp: entry.holdsUp === true,
    ...(entry.byPerson === true ? { byPerson: true as const } : {}),
    direction: entry.direction,
    run: entry.run,
    commit: entry.commit,
    harness: entry.harness,
    sameHarness: entry.sameHarness === true,
    agent: entry.agent,
    handle: entry.handle,
    model,
    state,
    outcome: checkOutcomes.find((item) => item === entry.outcome) ?? null,
    method: checkMethods.find((item) => item === entry.method) ?? null,
    result:
      typeof entry.result === 'string' && postId.test(entry.result)
        ? entry.result
        : null,
    note: typeof entry.note === 'string' ? entry.note.slice(0, 500) : null,
    queuedAt: entry.queuedAt,
    startedAt: recordTime(entry.startedAt),
    endedAt: recordTime(entry.endedAt),
    restarts: count(entry.restarts),
    ...(used &&
    typeof used.minutes === 'number' &&
    Number.isFinite(used.minutes) &&
    used.minutes >= 0
      ? { used: { minutes: used.minutes, turns: count(used.turns) } }
      : {}),
    session:
      typeof entry.session === 'string' &&
      /^\d{8}T\d{9}Z-[a-f0-9]{8}$/.test(entry.session)
        ? entry.session
        : null,
    generation: entry.generation.slice(0, 40),
    start:
      typeof entry.start === 'string' && commitId.test(entry.start)
        ? entry.start
        : null,
    blind: entry.blind !== false,
    ...spendOf(entry.spend),
  };
}

/** A saved cost estimate, or nothing for a record from before it or one that is not valid. */
function spendOf(value: unknown): { readonly spend?: Spend } {
  const entry = object(value);
  return entry &&
    usdValue(entry.usd) &&
    usdValue(entry.seen) &&
    typeof entry.session === 'string' &&
    validSessionId(entry.session)
    ? { spend: { usd: entry.usd, session: entry.session, seen: entry.seen } }
    : {};
}

const callPattern = /^c-[1-9]\d{0,5}$/;

/** The effect of the option that the person chose, or null. */
export function chosenEffect(call: Call): CallEffect | null {
  return call.answer
    ? (call.options[call.answer.option]?.effect ?? null)
    : null;
}

/** The answer of a call stands: the person answered, and Verifold applied its effect, when it has one. */
export function stands(call: Call): boolean {
  return (
    call.state === 'answered' &&
    (call.applied !== null || chosenEffect(call) === null)
  );
}

/**
 * The calls that `lab.json` keeps: the newest 500, and older answers of
 * pods and domains that stand, so that the first GPU pod does not ask again
 * and no shell loses a domain.
 */
export function keptCalls(calls: readonly Call[]): Call[] {
  const from = calls.length - 500;
  return calls.filter(
    (call, index) =>
      index >= from ||
      (stands(call) &&
        (call.applied?.type === 'pod' || call.applied?.type === 'domains')),
  );
}

/** A whole number from `min` to `max`, or a refusal that names `what`. */
export function whole(
  value: unknown,
  min: number,
  max: number,
  what: string,
): number {
  return wholeOr(
    value,
    min,
    max,
    `Give ${what} as a whole number from ${min} to ${max}.`,
  );
}

/** A whole number from `min` to `max`, or the refusal `message`. */
function wholeOr(
  value: unknown,
  min: number,
  max: number,
  message: string,
): number {
  return Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
    ? (value as number)
    : fail(message);
}

/**
 * The effect of an option, checked against the kind of its call: a pod and
 * pods at once go with cost, hours with cost or go, a direction with scope,
 * and domains with access. A refusal says why.
 */
export function callEffect(value: unknown, kind: CallKind): CallEffect | null {
  if (value === undefined || value === null) return null;
  const effect = object(value) ?? fail('Give an effect as an object.');
  const keys = Object.keys(effect);
  if (keys.length !== 1)
    fail(
      'Give one effect for each option: pod, podsAtOnce, hours, direction, or domains.',
    );
  const goes = (kinds: readonly CallKind[], what: string): void => {
    if (!kinds.includes(kind))
      fail(`${what} goes with a ${kinds.join(' or ')} call, not ${kind}.`);
  };
  if (effect.pod !== undefined) {
    goes(['cost'], 'A pod');
    const pod = object(effect.pod) ?? fail('Give the pod as an object.');
    return {
      type: 'pod',
      gpuType: text(pod.gpuType, 100, 'the GPU type of the pod'),
      hours: whole(pod.hours, 1, callLimits.podHours, "the pod's hours"),
      secrets: secretNames(pod.secrets),
    };
  }
  if (effect.podsAtOnce !== undefined) {
    goes(['cost'], 'Pods at once');
    return {
      type: 'podsAtOnce',
      pods: whole(effect.podsAtOnce, 1, callLimits.podsAtOnce, 'pods at once'),
    };
  }
  if (effect.hours !== undefined) {
    goes(['cost', 'go'], 'More hours');
    return {
      type: 'hours',
      hours: whole(effect.hours, 1, callLimits.hours, 'the hours'),
    };
  }
  if (effect.direction !== undefined) {
    goes(['scope'], 'A direction');
    const direction =
      object(effect.direction) ?? fail('Give the direction as an object.');
    if ((direction.open === undefined) === (direction.stop === undefined))
      fail(
        'Give the direction either open, with a title, or stop, such as d-2.',
      );
    if (direction.stop !== undefined)
      return {
        type: 'stop',
        direction:
          typeof direction.stop === 'string' && directionId.test(direction.stop)
            ? direction.stop
            : fail('Name the direction to stop, such as d-2.'),
      };
    return {
      type: 'open',
      title: text(
        direction.open,
        planLimits.title,
        'a title for the direction',
      ),
      harness:
        direction.harness === 'claude' || direction.harness === 'codex'
          ? direction.harness
          : fail('Give the harness of its agent: claude or codex.'),
      bar: text(
        direction.bar,
        planLimits.bar,
        'what makes the direction hold up',
      ),
    };
  }
  if (effect.domains !== undefined) {
    goes(['access'], 'Domains');
    const domains = Array.isArray(effect.domains)
      ? effect.domains.map((domain) =>
          typeof domain === 'string' ? domain.trim().toLowerCase() : '',
        )
      : [];
    if (
      !domains.length ||
      domains.length > callLimits.domains ||
      !domains.every(validDomain)
    )
      fail(`Give 1 to ${callLimits.domains} domains, such as pypi.org.`);
    return { type: 'domains', domains: [...new Set(domains)] };
  }
  return fail('Give an effect: pod, podsAtOnce, hours, direction, or domains.');
}

/** An effect as `lab.json` keeps it, checked as the agent's input was. */
function storedEffect(value: unknown, kind: CallKind): CallEffect | null {
  const effect = object(value);
  switch (effect?.type) {
    case undefined:
      return null;
    case 'pod':
      return callEffect(
        {
          pod: {
            gpuType: effect.gpuType,
            hours: effect.hours,
            secrets: effect.secrets,
          },
        },
        kind,
      );
    case 'hours':
      return callEffect({ hours: effect.hours }, kind);
    case 'podsAtOnce':
      return callEffect({ podsAtOnce: effect.pods }, kind);
    case 'open':
      return callEffect(
        {
          direction: {
            open: effect.title,
            harness: effect.harness,
            bar: effect.bar,
          },
        },
        kind,
      );
    case 'stop':
      return callEffect({ direction: { stop: effect.direction } }, kind);
    case 'domains':
      return callEffect({ domains: effect.domains }, kind);
    default:
      return fail('Unknown effect.');
  }
}

/**
 * The options of a call. A refusal says why. `effect` reads an option's
 * effect: an agent's input, or `storedEffect` for `lab.json`.
 */
export function callOptions(
  value: unknown,
  kind: CallKind,
  effect: (value: unknown, kind: CallKind) => CallEffect | null = callEffect,
): CallOption[] {
  const { min, max } = callLimits.options;
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail(`Give ${min} to ${max} options.`);
  return value.map((item) => {
    const option = object(item) ?? fail('Give each option as an object.');
    const amount = (
      field: unknown,
      top: number,
      what: string,
    ): number | null =>
      field === undefined || field === null
        ? null
        : typeof field === 'number' &&
            Number.isFinite(field) &&
            field >= 0 &&
            field <= top
          ? field
          : fail(`Give ${what} from 0 to ${top}.`);
    const detail = optionalText(
      option.detail,
      callLimits.detail,
      'the detail of each option',
    );
    return {
      label: text(option.label, callLimits.label, 'a label for each option'),
      ...(detail ? { detail } : {}),
      usd: amount(option.usd, callLimits.usd, 'the dollars'),
      minutes:
        option.minutes === undefined || option.minutes === null
          ? null
          : whole(option.minutes, 0, callLimits.minutes, 'the minutes'),
      effect: effect(option.effect, kind),
    };
  });
}

/**
 * What an answer changed, from `lab.json`. It must fit the effect of the
 * chosen option, so a damaged file cannot make a call stand. `by`: the
 * call's first asker, which a record of domains names.
 */
function parseApplied(
  value: unknown,
  by: string,
  effect: CallEffect | null,
): CallApplied | null {
  const entry = object(value);
  if (!entry || entry.type !== effect?.type) return null;
  if (entry.type === 'pod' && typeof entry.lease === 'string')
    return /^lease-\d{1,6}$/.test(entry.lease)
      ? { type: 'pod', lease: entry.lease }
      : null;
  if (entry.type === 'hours' && Number.isSafeInteger(entry.hours)) {
    const budget = object(entry.budget);
    return {
      type: 'hours',
      hours: entry.hours as number,
      deadline:
        typeof entry.deadline === 'string' &&
        !Number.isNaN(Date.parse(entry.deadline))
          ? entry.deadline
          : null,
      budget:
        budget &&
        Number.isSafeInteger(budget.hours) &&
        typeof budget.deadline === 'string' &&
        !Number.isNaN(Date.parse(budget.deadline))
          ? { hours: budget.hours as number, deadline: budget.deadline }
          : null,
    };
  }
  if (
    (entry.type === 'open' || entry.type === 'stop') &&
    typeof entry.direction === 'string' &&
    directionId.test(entry.direction)
  )
    return { type: entry.type, direction: entry.direction };
  if (entry.type === 'domains') return { type: 'domains', agent: by };
  if (
    entry.type === 'podsAtOnce' &&
    Number.isSafeInteger(entry.pods) &&
    Number.isSafeInteger(entry.before)
  )
    return {
      type: 'podsAtOnce',
      pods: entry.pods as number,
      before: entry.before as number,
    };
  return null;
}

/** A call from `lab.json`, or null for one that is not valid. */
function parseCall(value: unknown): Call | null {
  const entry = object(value);
  const states = ['open', 'answered', 'undoing', 'withdrawn'] as const;
  const state = states.find((item) => item === entry?.state);
  const kind = callKinds.find((item) => item === entry?.kind);
  if (
    !entry ||
    !state ||
    !kind ||
    typeof entry.id !== 'string' ||
    !callPattern.test(entry.id) ||
    typeof entry.at !== 'string' ||
    Number.isNaN(Date.parse(entry.at)) ||
    typeof entry.by !== 'string' ||
    (entry.by !== 'verifold' && !agentId.test(entry.by)) ||
    typeof entry.question !== 'string' ||
    typeof entry.why !== 'string'
  )
    return null;
  let options: CallOption[];
  try {
    options = callOptions(entry.options, kind, storedEffect);
  } catch {
    return null;
  }
  const answer = object(entry.answer);
  const option = answer?.option;
  const at = recordTime(answer?.at);
  const answered =
    Number.isSafeInteger(option) &&
    (option as number) >= 0 &&
    (option as number) < options.length &&
    at
      ? { option: option as number, at }
      : null;
  const facts = storedFacts(entry.facts);
  return {
    id: entry.id,
    at: entry.at,
    by: entry.by,
    direction:
      typeof entry.direction === 'string' && directionId.test(entry.direction)
        ? entry.direction
        : null,
    joined: Array.isArray(entry.joined)
      ? entry.joined.flatMap((item) => {
          const asker = object(item);
          return asker &&
            typeof asker.agent === 'string' &&
            agentId.test(asker.agent)
            ? [
                {
                  agent: asker.agent,
                  direction:
                    typeof asker.direction === 'string' &&
                    directionId.test(asker.direction)
                      ? asker.direction
                      : null,
                  why:
                    typeof asker.why === 'string'
                      ? asker.why.slice(0, callLimits.why)
                      : '',
                },
              ]
            : [];
        })
      : [],
    kind,
    need:
      callNeeds.find((item) => item === entry.need) ??
      // A pods call from before calls had a need: Verifold wrote it with two
      // options without effects, the second "No GPU for this lab".
      (entry.need === undefined &&
      kind === 'access' &&
      options.length === 2 &&
      options.every((item) => !item.effect) &&
      options[1]?.label === 'No GPU for this lab'
        ? 'pods'
        : null),
    question: entry.question.slice(0, callLimits.question),
    options,
    pick:
      Number.isSafeInteger(entry.pick) &&
      (entry.pick as number) >= 0 &&
      (entry.pick as number) < options.length
        ? (entry.pick as number)
        : null,
    why: entry.why.slice(0, callLimits.why),
    undoMinutes: Number.isSafeInteger(entry.undoMinutes)
      ? Math.min(
          Math.max(entry.undoMinutes as number, 0),
          callLimits.undoMinutes,
        )
      : callLimits.defaultUndo,
    deadline: recordTime(entry.deadline),
    state,
    answer: answered,
    words:
      typeof entry.words === 'string' && entry.words.trim()
        ? entry.words.slice(0, callLimits.words)
        : null,
    post:
      typeof entry.post === 'string' && postId.test(entry.post)
        ? entry.post
        : null,
    undoUntil: recordTime(entry.undoUntil),
    applied: parseApplied(
      entry.applied,
      entry.by,
      answered ? (options[answered.option]?.effect ?? null) : null,
    ),
    note: typeof entry.note === 'string' ? entry.note.slice(0, 500) : null,
    ...(facts.length ? { facts } : {}),
    ...(typeof entry.held === 'string' && entry.held
      ? {
          held: entry.held.slice(0, heldChars),
          ...(entry.heldByPerson === true ? { heldByPerson: true } : {}),
        }
      : {}),
  };
}

/** The most characters of the lines that a question of the planner holds: an answer in words, and the line around it, a few times. */
const heldChars = 12_000;

/** A question's held lines and one more. Past `heldChars`, the oldest go, so the newest answer stays. */
export function moreHeld(held: string | undefined, line: string): string {
  const all = held ? `${held} ${line}` : line;
  return all.length > heldChars ? `…${all.slice(1 - heldChars)}` : all;
}

/** The fields of a `verifold_run` call that every run has: the command, why, its minutes up to `most`, and its outputs. */
export function runArgs(
  args: Record<string, unknown>,
  most: number,
  more = '',
): {
  readonly command: string;
  readonly why: string;
  readonly minutes: number;
  readonly want: string[];
} {
  const minutes =
    args.minutes === undefined
      ? Math.min(runLimits.defaultMinutes, most)
      : wholeOr(
          args.minutes,
          1,
          most,
          `Give the minutes as a whole number from 1 to ${most}${more}.`,
        );
  const outputs = Array.isArray(args.outputs) ? args.outputs : [];
  if (outputs.length > runLimits.outputPaths)
    fail(`Name up to ${runLimits.outputPaths} outputs.`);
  const want = [...new Set(outputs.map((path) => projectPath(path)))];
  if (want.includes('.'))
    fail('Name files or folders in the copy, not the whole copy.');
  return {
    command: text(args.command, runLimits.command, 'the command'),
    why: text(args.why, runLimits.why, 'what the run tests'),
    minutes,
    want,
  };
}

/** A whole value that is an agent handle. */
const handleId = new RegExp(`^${handlePattern}$`);

export function text(value: unknown, limit: number, what: string): string {
  return typeof value === 'string' &&
    value.trim() &&
    value.trim().length <= limit
    ? value.trim()
    : fail(`Write ${what}, up to ${limit} characters.`);
}

/** The `verifold_status` of an agent at `at`. Throws when a field is missing or too long. */
export function statusLine(
  args: Record<string, unknown>,
  at: string,
): StatusLine {
  return {
    doing: text(args.doing, threadLimits.status, 'what you do now'),
    why: text(args.why, threadLimits.status, 'why you do it'),
    next: text(args.next, threadLimits.status, 'what comes next'),
    at,
  };
}

/** The agent without its own line, which a new verdict makes old. */
export function withoutLine(agent: AgentRecord): AgentRecord {
  const next: { -readonly [Key in keyof AgentRecord]: AgentRecord[Key] } = {
    ...agent,
  };
  delete next.statusLine;
  return next;
}

function parseStatusLine(value: unknown): StatusLine | null {
  const entry = object(value);
  const field = (name: string): string | null => {
    const item = entry?.[name];
    return typeof item === 'string' && item.length <= threadLimits.status
      ? item
      : null;
  };
  const [doing, why, next, at] = ['doing', 'why', 'next', 'at'].map(field);
  return doing && why && next && at && !Number.isNaN(Date.parse(at))
    ? { doing, why, next, at }
    : null;
}

function parseDirection(value: unknown): Direction | null {
  const entry = object(value);
  const workspace = parseWorkspace(entry?.workspace);
  if (
    !entry ||
    !workspace ||
    typeof entry.id !== 'string' ||
    !directionId.test(entry.id) ||
    typeof entry.title !== 'string' ||
    typeof entry.openedBy !== 'string' ||
    typeof entry.openedAt !== 'string' ||
    (entry.state !== 'open' &&
      entry.state !== 'stopped' &&
      entry.state !== 'closed') ||
    typeof entry.agent !== 'string' ||
    !agentId.test(entry.agent) ||
    typeof entry.head !== 'string' ||
    !commitId.test(entry.head)
  )
    return null;
  return {
    id: entry.id,
    title: entry.title.slice(0, labLimits.title),
    // A direction from before jobs and teams has neither.
    job:
      typeof entry.job === 'string' ? entry.job.slice(0, planLimits.job) : null,
    team:
      typeof entry.team === 'string'
        ? entry.team.slice(0, planLimits.team)
        : null,
    longShot: entry.longShot === true,
    bar:
      typeof entry.bar === 'string' ? entry.bar.slice(0, labLimits.bar) : null,
    runs:
      Number.isSafeInteger(entry.runs) &&
      (entry.runs as number) >= 1 &&
      (entry.runs as number) <= planLimits.runs
        ? (entry.runs as number)
        : null,
    noise:
      typeof entry.noise === 'string'
        ? entry.noise.slice(0, planLimits.noise)
        : null,
    buildsOn: Array.isArray(entry.buildsOn)
      ? entry.buildsOn
          .flatMap((item) => {
            const work = object(item);
            return work &&
              typeof work.text === 'string' &&
              typeof work.known === 'boolean'
              ? [
                  {
                    text: work.text.slice(0, planLimits.buildsOnText),
                    known: work.known,
                  },
                ]
              : [];
          })
          .slice(0, planLimits.buildsOn)
      : [],
    openedBy: entry.openedBy.slice(0, 20),
    openedAt: entry.openedAt,
    state: entry.state,
    stoppedAt: typeof entry.stoppedAt === 'string' ? entry.stoppedAt : null,
    // A direction from before verdicts is open.
    verdict: verdicts.find((verdict) => verdict === entry.verdict) ?? 'open',
    evidence: (() => {
      const evidence = object(entry.evidence);
      return evidence &&
        typeof evidence.text === 'string' &&
        typeof evidence.post === 'string' &&
        postId.test(evidence.post)
        ? {
            text: evidence.text.slice(0, directionLimits.evidence),
            post: evidence.post,
            run:
              typeof evidence.run === 'string' && runId.test(evidence.run)
                ? evidence.run
                : null,
          }
        : null;
    })(),
    agent: entry.agent,
    workspace,
    head: entry.head,
  };
}

/** A path of a project file in a lab record, by the board's rule for paths, or null. */
function recordPath(value: unknown): string | null {
  return safePath(value) ? value : null;
}

/** A time in a lab record, or null. */
function recordTime(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function parseBrought(value: unknown): Brought | null {
  const entry = object(value);
  const at = recordTime(entry?.at);
  const path = recordPath(entry?.path);
  return entry &&
    at &&
    path &&
    typeof entry.direction === 'string' &&
    directionId.test(entry.direction) &&
    typeof entry.commit === 'string' &&
    commitId.test(entry.commit)
    ? { direction: entry.direction, path, commit: entry.commit, at }
    : null;
}

function parseSignoff(value: unknown): Signoff | null {
  const entry = object(value);
  const at = recordTime(entry?.at);
  if (!entry || !at || !Array.isArray(entry.directions)) return null;
  return {
    at,
    note:
      typeof entry.note === 'string'
        ? entry.note.slice(0, labLimits.signoff)
        : null,
    directions: entry.directions
      .flatMap((item) => {
        const direction = object(item);
        const verdict = verdicts.find((word) => word === direction?.verdict);
        return direction &&
          verdict &&
          typeof direction.id === 'string' &&
          directionId.test(direction.id) &&
          typeof direction.commit === 'string' &&
          commitId.test(direction.commit)
          ? [
              {
                id: direction.id,
                verdict,
                commit: direction.commit,
                check:
                  typeof direction.check === 'string' &&
                  checkPattern.test(direction.check)
                    ? direction.check
                    : null,
              },
            ]
          : [];
      })
      .slice(0, labLimits.signoffDirections),
  };
}

export function parseState(
  value: Record<string, unknown> | null,
): LabState | null {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.question !== 'string' ||
    typeof value.startedAt !== 'string' ||
    !Array.isArray(value.directions)
  )
    return null;
  const handles = object(value.handles);
  const roles = object(value.roles);
  const count = (number: unknown): number =>
    Number.isSafeInteger(number) && (number as number) >= 0
      ? (number as number)
      : 0;
  const pausedAt = typeof value.pausedAt === 'string' ? value.pausedAt : null;
  const plan = object(value.plan);
  const budget = object(value.budget);
  return {
    schemaVersion: 1,
    question: value.question.slice(0, labLimits.question),
    startedAt: value.startedAt,
    pausedAt,
    // A lab from before time budgets was paused by the person.
    pausedFor: !pausedAt
      ? null
      : value.pausedFor === 'deadline'
        ? 'deadline'
        : 'person',
    handles: { claude: count(handles?.claude), codex: count(handles?.codex) },
    // A lab from before role names has none, and keeps its handles.
    roles: roles
      ? { agents: count(roles.agents), checkers: count(roles.checkers) }
      : null,
    share: labShares.find((entry) => entry === value.share) ?? null,
    directions: value.directions.flatMap((entry) => {
      const direction = parseDirection(entry);
      return direction ? [direction] : [];
    }),
    opener:
      typeof value.opener === 'string' && agentId.test(value.opener)
        ? value.opener
        : null,
    plan:
      plan &&
      typeof plan.post === 'string' &&
      postId.test(plan.post) &&
      typeof plan.at === 'string' &&
      typeof plan.reading === 'string' &&
      typeof plan.cost === 'string' &&
      Array.isArray(plan.directions)
        ? {
            post: plan.post,
            at: plan.at,
            reading: plan.reading.slice(0, planLimits.reading),
            cost: plan.cost.slice(0, planLimits.cost),
            directions: plan.directions
              .filter(
                (id): id is string =>
                  typeof id === 'string' && directionId.test(id),
              )
              .slice(0, labLimits.directions),
            facts: storedFacts(plan.facts),
            ...(typeof plan.factsPost === 'string' &&
            postId.test(plan.factsPost)
              ? { factsPost: plan.factsPost }
              : {}),
            ...(Number.isSafeInteger(plan.version) &&
            (plan.version as number) >= 1
              ? { version: plan.version as number }
              : {}),
            ...(typeof plan.previous === 'string' && postId.test(plan.previous)
              ? { previous: plan.previous }
              : {}),
            ...(typeof plan.changed === 'string' && plan.changed.trim()
              ? { changed: plan.changed.slice(0, planLimits.changed) }
              : {}),
          }
        : null,
    budget:
      budget &&
      Number.isSafeInteger(budget.hours) &&
      (budget.hours as number) > 0 &&
      typeof budget.deadline === 'string' &&
      !Number.isNaN(Date.parse(budget.deadline))
        ? { hours: budget.hours as number, deadline: budget.deadline }
        : null,
    agentStarts: Array.isArray(value.agentStarts)
      ? value.agentStarts
          .filter(
            (at): at is string =>
              typeof at === 'string' && !Number.isNaN(Date.parse(at)),
          )
          .slice(-directionLimits.starts * 2)
      : [],
    // A lab from before checks has none.
    checks: Array.isArray(value.checks)
      ? value.checks
          .flatMap((entry) => {
            const check = parseCheck(entry);
            return check ? [check] : [];
          })
          .slice(-500)
      : [],
    // A lab from before calls has none, so its next GPU pod asks.
    calls: Array.isArray(value.calls)
      ? keptCalls(
          value.calls.flatMap((entry) => {
            const call = parseCall(entry);
            return call ? [call] : [];
          }),
        )
      : [],
    // A lab from before bring-ins and sign-offs has none.
    // A lab from before bring-ins has none. Each file keeps its newest base.
    brought: Array.isArray(value.brought)
      ? [
          ...new Map(
            value.brought.flatMap((item) => {
              const entry = parseBrought(item);
              return entry
                ? [[`${entry.direction}\0${entry.path}`, entry] as const]
                : [];
            }),
          ).values(),
        ]
      : [],
    bringing: (() => {
      const entry = object(value.bringing);
      const at = recordTime(entry?.at);
      return entry &&
        at &&
        typeof entry.direction === 'string' &&
        directionId.test(entry.direction) &&
        typeof entry.commit === 'string' &&
        commitId.test(entry.commit) &&
        Array.isArray(entry.files) &&
        (entry.phase === 'checking' || entry.phase === 'copying')
        ? {
            direction: entry.direction,
            commit: entry.commit,
            files: entry.files
              .flatMap((path) => recordPath(path) ?? [])
              .slice(0, labLimits.bringFiles),
            at,
            phase: entry.phase,
          }
        : null;
    })(),
    signoff: parseSignoff(value.signoff),
  };
}

/** Whole hours for a time budget: a number from 1 to `labLimits.hours`. */
export function hours(value: unknown): number {
  const count =
    typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : value;
  return wholeOr(
    count,
    1,
    labLimits.hours,
    `Give the time in whole hours, from 1 to ${labLimits.hours}.`,
  );
}

/** What a direction builds on, from an agent's tool call. */
export function works(value: unknown): BuildsOn[] {
  const listed = Array.isArray(value) ? value : [];
  if (listed.length > planLimits.buildsOn)
    fail(`Give up to ${planLimits.buildsOn} works that a direction builds on.`);
  return listed.map((work) => {
    const entry = object(work);
    return entry && typeof entry.known === 'boolean'
      ? {
          text: text(
            entry.text,
            planLimits.buildsOnText,
            'each work that a direction builds on',
          ),
          known: entry.known,
        }
      : fail('Each work that a direction builds on has text and known.');
  });
}

/** An optional text field: absent or empty gives null. */
export function optionalText(
  value: unknown,
  limit: number,
  what: string,
): string | null {
  return value === undefined || value === null || value === ''
    ? null
    : text(value, limit, what);
}

/** An optional field of a fact: text that is not blank, else null. */
function factText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * One fact of a plan or a call. `at`: when the plan or the call is posted.
 * `place`: the fact's place in the list, for the error. One bad source or
 * date does not refuse the plan: it counts as missing, or a long date is cut.
 */
function planFact(value: unknown, at: string, place: number): PlanFact {
  const entry =
    object(value) ?? fail(`Fact ${place}: give it as an object with a claim.`);
  const claim = factText(entry.claim);
  if (!claim || claim.length > planLimits.claim)
    fail(
      `Fact ${place}: write its claim in ${planLimits.claim} characters or fewer.`,
    );
  const source = factText(entry.source);
  const sourceDate = factText(entry.sourceDate);
  return {
    claim,
    // A cut web address still looks like a link, so a long source counts as missing.
    source: source && source.length <= planLimits.source ? source : null,
    sourceDate: sourceDate && clip(sourceDate, planLimits.sourceDate),
    checkedAt: at,
  };
}

/** The facts of an agent's plan or call, checked. `at`: when the plan or the call is posted. */
export function planFacts(value: unknown, at: string): PlanFact[] {
  if (!Array.isArray(value))
    fail(`Give facts as a list of at most ${planLimits.facts}.`);
  if (value.length > planLimits.facts)
    fail(`List at most ${planLimits.facts} facts. You listed ${value.length}.`);
  return value.map((item, index) => planFact(item, at, index + 1));
}

/** A fact of a plan or a call from `lab.json`, or null for one that is not valid. */
function storedFact(value: unknown): PlanFact | null {
  const checkedAt = recordTime(object(value)?.checkedAt);
  if (!checkedAt) return null;
  try {
    return planFact(value, checkedAt, 1);
  } catch {
    return null;
  }
}

/** Two lists of facts say the same: the same claims, sources and dates, in the same order. */
export function sameFacts(
  first: readonly PlanFact[],
  second: readonly PlanFact[],
): boolean {
  return (
    first.length === second.length &&
    first.every((fact, index) => {
      const other = second[index];
      return (
        other !== undefined &&
        fact.claim === other.claim &&
        fact.source === other.source &&
        fact.sourceDate === other.sourceDate
      );
    })
  );
}

/** The valid facts of a stored list, within the limit. */
function storedFacts(value: unknown): PlanFact[] {
  return Array.isArray(value)
    ? value
        .flatMap((entry: unknown) => {
          const fact = storedFact(entry);
          return fact ? [fact] : [];
        })
        .slice(0, planLimits.facts)
    : [];
}

/** The repeat runs that a bar needs, from an agent's tool call. */
export function repeatRuns(value: unknown): number {
  return wholeOr(
    value,
    1,
    planLimits.runs,
    `Give the repeat runs that a bar needs, from 1 to ${planLimits.runs}.`,
  );
}

export function parseAgent(
  value: Record<string, unknown> | null,
): AgentRecord | null {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.id !== 'string' ||
    !agentId.test(value.id) ||
    typeof value.handle !== 'string' ||
    !handleId.test(value.handle) ||
    (value.host !== 'claude' && value.host !== 'codex') ||
    typeof value.direction !== 'string' ||
    !directionId.test(value.direction) ||
    typeof value.startedAt !== 'string' ||
    typeof value.generation !== 'string' ||
    typeof value.cursor !== 'number' ||
    typeof value.readThrough !== 'number' ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.wakeups) ||
    !Array.isArray(value.actions)
  )
    return null;
  const model =
    typeof value.model === 'string' && value.model.trim() ? value.model : null;
  try {
    validateModel(model ?? undefined);
  } catch {
    return null;
  }
  const times = (list: unknown): string[] =>
    Array.isArray(list)
      ? list.filter(
          (entry): entry is string =>
            typeof entry === 'string' && !Number.isNaN(Date.parse(entry)),
        )
      : [];
  const factsPost =
    typeof value.factsPost === 'string' && postId.test(value.factsPost)
      ? value.factsPost
      : null;
  const linked = object(value.linked);
  const line = parseStatusLine(value.statusLine);
  return {
    schemaVersion: 1,
    id: value.id,
    handle: value.handle,
    host: value.host,
    model,
    direction: value.direction,
    startedAt: value.startedAt,
    stoppedAt: typeof value.stoppedAt === 'string' ? value.stoppedAt : null,
    stopReason:
      value.stopReason === 'person' ||
      value.stopReason === 'crashed' ||
      value.stopReason === 'closed'
        ? value.stopReason
        : null,
    generation: value.generation.slice(0, 40),
    session:
      typeof value.session === 'string' &&
      /^\d{8}T\d{9}Z-[a-f0-9]{8}$/.test(value.session)
        ? value.session
        : null,
    toolsVersion: Number.isSafeInteger(value.toolsVersion)
      ? (value.toolsVersion as number)
      : 0,
    readThrough: value.readThrough,
    seen: Array.isArray(value.seen)
      ? value.seen
          .filter(
            (entry): entry is string =>
              typeof entry === 'string' && postId.test(entry),
          )
          .slice(-boardLimits.seen)
      : [],
    cursor: value.cursor,
    wakeups: times(value.wakeups).slice(-labLimits.wakeupsPerHour * 2),
    events: value.events.flatMap((entry) => {
      const event = object(entry);
      return event &&
        typeof event.seq === 'number' &&
        typeof event.at === 'string' &&
        typeof event.text === 'string' &&
        [
          'post',
          'person',
          'restart',
          'quota',
          'continue',
          'run',
          'pod',
          'call',
          'helper',
          'notice',
        ].includes(event.kind as string)
        ? [event as unknown as QueuedEvent<LabEvent>]
        : [];
    }),
    idleStreak: Number.isSafeInteger(value.idleStreak)
      ? (value.idleStreak as number)
      : 0,
    quietTurns: Number.isSafeInteger(value.quietTurns)
      ? (value.quietTurns as number)
      : 0,
    quietWork: Number.isSafeInteger(value.quietWork)
      ? (value.quietWork as number)
      : 0,
    nudged: value.nudged === true,
    finished: value.finished === true,
    folder:
      typeof value.folder === 'string' && /^[0-9a-f]{64}$/.test(value.folder)
        ? value.folder
        : null,
    ...(linked &&
    typeof linked.print === 'string' &&
    /^[0-9a-f]{64}$/.test(linked.print) &&
    Array.isArray(linked.paths) &&
    linked.paths.every((path): path is string => typeof path === 'string') &&
    Number.isSafeInteger(linked.count) &&
    (linked.count as number) >= 0 &&
    typeof linked.told === 'boolean'
      ? {
          linked: {
            print: linked.print,
            paths: linked.paths.slice(0, 5),
            count: linked.count as number,
            told: linked.told,
          },
        }
      : {}),
    restarts: times(value.restarts),
    actions: value.actions.flatMap((entry) => {
      const action = object(entry);
      return action &&
        typeof action.key === 'string' &&
        typeof action.at === 'string' &&
        typeof action.tool === 'string' &&
        typeof action.ok === 'boolean' &&
        typeof action.result === 'string'
        ? [action as unknown as LabAction]
        : [];
    }),
    lastRead: (() => {
      const read = object(value.lastRead);
      return read &&
        typeof read.key === 'string' &&
        typeof read.text === 'string'
        ? { key: read.key.slice(0, 200), text: read.text }
        : null;
    })(),
    held: value.held === true,
    // A record from before this field: its thread may have had the pod tools, so it keeps its conversation.
    pods: value.pods !== false,
    ...(factsPost ? { factsPost } : {}),
    ...spendOf(value.spend),
    ...(line ? { statusLine: line } : {}),
  };
}

/** The time budget of a lab that the person did not give one. */
export const defaultLabHours = 8;
