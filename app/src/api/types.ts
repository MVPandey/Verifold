/**
 * The app API's messages, as the server's Pydantic schemas define them in `protocol/app.py`, `protocol/join.py`,
 * and `protocol/posts.py`. Field names stay in the server's snake case, so a payload needs no translation.
 */

export type AgentState = 'starting' | 'working' | 'waiting' | 'idle' | 'stopped';
export type PostKind =
  | 'message'
  | 'plan'
  | 'result'
  | 'ask'
  | 'answer'
  | 'objection'
  | 'proposal'
  | 'check'
  | 'ruled_out';
export type Standing = 'open' | 'checked' | 'held_up' | 'disputed' | 'conceded';

export interface ModelSpec {
  readonly family: string;
  readonly name: string | null;
  readonly effort: string | null;
}

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly harness: string;
  readonly model: ModelSpec;
  readonly role: string;
  readonly brief: string;
  /** The harness mode that the person chose. `null` follows the lab's auto mode choice. */
  readonly mode: string | null;
  readonly recruited_by: string | null;
  /** For a blind checker: the post that it reruns. */
  readonly checks: string | null;
}

export interface AgentActivity {
  readonly state: AgentState;
  /** The latest step that the harness reported, such as a tool call's title. */
  readonly detail: string;
  readonly at: string | null;
}

export interface Usage {
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
}

export interface AgentView {
  readonly agent: Agent;
  readonly activity: AgentActivity;
  readonly turns: number;
  readonly posts: number;
  readonly usage: Usage;
  /** `null` when the harness reports tokens only. */
  readonly cost_usd: number | null;
}

export interface LabView {
  readonly question: string;
  readonly opened_at: string;
  readonly seq: number;
  readonly agents: readonly AgentView[];
  readonly threads: number;
  readonly posts: number;
  readonly needs_you: number;
  readonly ends_at: string | null;
  readonly out_of_time: boolean;
  /** The settings that the lab follows. */
  readonly settings: Settings;
}

/** What happens to the processes that agents left running when the lab's time ends, or the person stops it. */
export type AtTimeLimit = 'pause' | 'stop' | 'finish';

/** What happens to the processes that agents left running when Verifold exits. */
export type AtExit = 'stop' | 'keep';

export interface JobSettings {
  readonly at_time_limit: AtTimeLimit;
  readonly at_exit: AtExit;
}

export interface Settings {
  readonly version: number;
  readonly jobs: JobSettings;
}

/** Where a setting lives: in one project's file, which wins, or in the file for all projects. */
export type SettingsLevel = 'project' | 'all';

/** One of the person's settings files: where it is, what it holds as written, and what it adds up to. */
export interface SettingsFileView {
  readonly path: string;
  readonly values: Readonly<Record<string, unknown>>;
  /** A hash of the file. A change names it, so that it can't overwrite a change that the person didn't see. */
  readonly revision: string;
  /** For all projects: the file over Verifold's defaults. For a project: its file over the one for all projects. */
  readonly settings: Settings;
  /** What new labs start with at this level, added up in the same way. */
  readonly defaults: SetupDefaults;
}

export interface SettingsView {
  readonly all_projects: SettingsFileView;
  readonly project: SettingsFileView;
  /** The settings that the folder's lab follows, or `null` before a lab starts. */
  readonly lab: Settings | null;
}

/** The settings that the app changes. */
export type SettingKey = 'jobs.at_time_limit' | 'jobs.at_exit' | 'setup';

/**
 * The person changes one setting. A `null` value removes it, so the one for all projects, or Verifold's default,
 * applies. The change names both files' revisions, because the files add up.
 */
export interface SettingsChange {
  readonly level: SettingsLevel;
  readonly key: SettingKey;
  readonly value: string | SetupChoices | null;
  readonly revisions: { readonly project: string; readonly all_projects: string };
}

/** One value that a harness offers for an option, with the name that the harness shows for it. */
export interface OptionValue {
  readonly value: string;
  readonly name: string;
}

/** A model that a harness offers, and the effort levels that the harness offers with it. */
export interface ModelValue extends OptionValue {
  /** `null` when the harness didn't switch to the model, so its effort levels are not known. */
  readonly efforts: readonly OptionValue[] | null;
}

/**
 * The models, effort levels, and modes that a harness offers, and the person's current ones.
 *
 * `efforts` and `effort` are for the person's current model. Each model in `models` has its own effort levels.
 */
export interface Offer {
  readonly models: readonly ModelValue[];
  readonly efforts: readonly OptionValue[];
  readonly modes: readonly OptionValue[];
  readonly model: string | null;
  readonly effort: string | null;
  readonly mode: string | null;
}

export interface HarnessOption {
  readonly name: string;
  readonly title: string;
  readonly family: string;
  readonly available: boolean;
  /** Verifold is still asking the harness what it offers. */
  readonly probing: boolean;
  /** What the harness offers, or `null` until it answers, or when it didn't. */
  readonly offer: Offer | null;
}

export interface SetupView {
  readonly folder: string;
  readonly harnesses: readonly HarnessOption[];
  /** The question of the folder's lab, or `null` before a lab starts. */
  readonly question: string | null;
  /** What the setup starts with: the person's saved choices for new labs, or Verifold's defaults. */
  readonly defaults: SetupDefaults;
  /** The settings file that the saved choices come from, which can be the project's own, or `null`. */
  readonly defaults_from: string | null;
}

/** An agent choice as the server sends it back, with `null` for what it leaves to the harness. */
export interface SavedChoice {
  readonly harness: string;
  readonly count: number;
  readonly model: string | null;
  readonly effort: string | null;
  readonly mode: string | null;
}

/** What new labs start with unless the person chooses otherwise. */
export interface SetupDefaults {
  /** `null` starts one agent of each harness that this computer has. */
  readonly agents: readonly SavedChoice[] | null;
  readonly auto_mode: boolean;
  /** `null` means no time limit. */
  readonly minutes: number | null;
}

/** The choices for new labs, as the app saves them. */
export interface SetupChoices {
  readonly agents: readonly AgentChoice[];
  readonly auto_mode: boolean;
  readonly minutes: number | null;
}

export interface AgentChoice {
  readonly harness: string;
  readonly count: number;
  readonly model?: string;
  readonly effort?: string;
  /** One of the harness's own modes. Without it, the agents follow the lab's auto mode choice. */
  readonly mode?: string;
}

export interface StartRequest {
  readonly question: string;
  readonly agents: readonly AgentChoice[];
  readonly auto_mode: boolean;
  readonly minutes?: number;
}

export interface Thread {
  readonly id: string;
  readonly title: string;
  readonly opened_by: string;
}

export interface FileEvidence {
  readonly type: 'file';
  readonly path: string;
  readonly commit: string;
}

interface PostBase {
  readonly id: string;
  readonly thread: string;
  readonly author: string;
  /** The headline that readers scan. */
  readonly text: string;
  /** The detail. */
  readonly body: string;
  readonly reply_to: string | null;
  readonly mentions: readonly string[];
  /** The posts that this one builds on, in any thread. */
  readonly builds_on: readonly string[];
  readonly evidence: readonly FileEvidence[];
}

export type Post =
  | (PostBase & {
      readonly kind: 'message' | 'plan' | 'result' | 'objection' | 'proposal' | 'ruled_out';
    })
  | (PostBase & { readonly kind: 'ask'; readonly choices: readonly string[] })
  | (PostBase & { readonly kind: 'answer'; readonly accepts: boolean })
  | (PostBase & {
      readonly kind: 'check';
      readonly outcome: 'holds' | 'fails';
      readonly method: 'rerun' | 'code_read' | 'ratings';
    });

export interface PostView {
  readonly seq: number;
  readonly at: string;
  readonly post: Post;
  readonly standing: Standing;
  /** The posts that build on this one, oldest first. */
  readonly built_on_by: readonly string[];
}

export interface ThreadView {
  readonly thread: Thread;
  readonly watching: boolean;
  readonly posts: readonly PostView[];
}

export interface PostLine {
  readonly id: string;
  readonly thread: string;
  readonly author: string;
  readonly kind: PostKind;
  readonly text: string;
  readonly reply_to: string | null;
  readonly seq: number;
  readonly at: string;
}

export interface ThreadSummary {
  readonly thread: Thread;
  readonly watching: boolean;
  readonly posts: number;
  readonly last_at: string;
  readonly latest: PostLine | null;
  readonly disputed: number;
  readonly checked: number;
  readonly not_checked: number;
  readonly open_asks: number;
}

export interface PostRequest {
  readonly kind: PostKind;
  readonly text: string;
  readonly body?: string;
  readonly thread?: string;
  readonly new_thread?: string;
  readonly reply_to?: string;
  readonly mentions?: readonly string[];
}

/** The person's own author ID on the board. */
export const PERSON = 'person';
