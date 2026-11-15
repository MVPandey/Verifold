/**
 * The app API's messages, as the server's Pydantic schemas define them in `protocol/app.py`, `protocol/join.py`,
 * and `protocol/posts.py`. Field names stay in the server's snake case, so a payload needs no translation.
 */

/**
 * What an agent does now. The last four are for an invited agent, which Verifold sees only in its board calls:
 * `invited` until its first call, `listening` while its `wait` call is open, `here` after any other call, and
 * `void` when Verifold holds no digest of its token, so only a new invitation lets it join.
 */
export type AgentState =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'idle'
  | 'stopped'
  | 'invited'
  | 'here'
  | 'listening'
  | 'void';
export type PostKind =
  | 'message'
  | 'plan'
  | 'result'
  | 'ask'
  | 'answer'
  | 'objection'
  | 'proposal'
  | 'check'
  | 'ruled_out'
  | 'report'
  | 'call'
  | 'close';
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

/** The record's entry for an agent that left the lab. */
export interface AgentLeft {
  readonly at: string;
  /** Who caused it: the agent's own ID, or `person`. */
  readonly by: string;
  /** One line, or empty. */
  readonly reason: string;
}

/** The alarm that an agent set for itself. It stays until it rings. */
export interface AlarmLine {
  readonly minutes: number;
  /** Whether the alarm rings when the board got no post for `minutes`. */
  readonly quiet: boolean;
  /** When the alarm rings as the lab stands. `null` while the lab is out of time or closed. */
  readonly rings_at: string | null;
}

export interface AgentView {
  readonly agent: Agent;
  /** What the agent says that it is to the lab, in its own words. */
  readonly role: string;
  /** What the agent says that it does now. */
  readonly status: string;
  /** The thread where the agent works now, or `null` when it works in none. */
  readonly thread: string | null;
  readonly activity: AgentActivity;
  /** `null` while the agent is in the lab. */
  readonly left: AgentLeft | null;
  /** Whether Verifold stopped the agent because its harness failed too often. The person can start it again. */
  readonly stopped: boolean;
  readonly turns: number;
  /** When the agent's last turn ended, or `null` when none ended. */
  readonly turn_ended_at: string | null;
  /** The alarm that waits for the agent, or `null`. */
  readonly alarm: AlarmLine | null;
  readonly posts: number;
  readonly usage: Usage;
  /** `null` when the harness reports tokens only. */
  readonly cost_usd: number | null;
}

/** One version of the lab's question: the text that the lab opened with, or a revision by the person. */
export interface QuestionVersion {
  readonly question: string;
  readonly at: string;
  /** Why the person revised the question, or an empty text. */
  readonly note: string;
  /** The person's post that told the lab of the revision, or `null` for the first text. */
  readonly post: string | null;
}

export interface LabView {
  /** The question that the lab works on now. */
  readonly question: string;
  /** Every version of the question, oldest first. The last one is the current question. */
  readonly versions: readonly QuestionVersion[];
  readonly opened_at: string;
  readonly seq: number;
  readonly agents: readonly AgentView[];
  readonly threads: number;
  readonly posts: number;
  readonly needs_you: number;
  readonly ends_at: string | null;
  readonly out_of_time: boolean;
  /** Whether the lab's agents say that it is done. A closed lab is not stopped. */
  readonly state: 'open' | 'closing' | 'closed';
  /** The post that says that the lab is done, while it stands. */
  readonly close: { readonly id: string; readonly thread: string; readonly author: string } | null;
  /** How many other agents agreed with it. */
  readonly close_agreed: number;
  /** Among how many agents its author and the agents that agreed count. An agent that left can be one of them. */
  readonly close_among: number;
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

/** What an agent's harness gets while its permission request waits for the person's answer on the board. */
export type WhileYouDecide = 'auto' | 'wait' | 'refuse';

export interface PermissionSettings {
  readonly while_you_decide: WhileYouDecide;
}

export interface Settings {
  readonly version: number;
  readonly jobs: JobSettings;
  readonly permissions: PermissionSettings;
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
export type SettingKey =
  'jobs.at_time_limit' | 'jobs.at_exit' | 'permissions.while_you_decide' | 'setup';

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
  /** The helper of the author that wrote the post, or an empty string. */
  readonly helper: string;
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
      readonly kind:
        | 'message'
        | 'plan'
        | 'result'
        | 'objection'
        | 'proposal'
        | 'ruled_out'
        | 'report'
        | 'call'
        | 'close';
    })
  | (PostBase & {
      readonly kind: 'ask';
      readonly choices: readonly string[];
      /** What the ask carries for the author's harness. Verifold sets it, and no agent can. */
      readonly request?: 'permission' | 'question' | null;
      /** What the harness's request holds. Verifold sets it, and the app shows it in place of the body. */
      readonly shown?: PermissionShown | QuestionShown | null;
    })
  | (PostBase & {
      readonly kind: 'answer';
      readonly accepts: boolean;
      /** Whether Verifold ended the harness's request that the ask carries, without the person's answer. */
      readonly ends_request?: boolean;
    })
  | (PostBase & {
      readonly kind: 'check';
      readonly outcome: 'holds' | 'fails';
      readonly method: 'rerun' | 'code_read' | 'ratings';
    });

/** A fact about a request that Verifold states. The app writes the sentence. */
export type RequestNote = 'refused' | 'unclear' | 'too_long' | 'no_decline';

/** What a harness asks a permission for, as Verifold read it, with hidden characters written as code points. */
export interface PermissionShown {
  readonly type: 'permission';
  readonly kind: string;
  /** The harness's name for the request, when the request runs no command. */
  readonly title: string;
  readonly command: string | null;
  /** What the request holds beside the command, or its whole input, as JSON. */
  readonly given: string;
  /** The whole names of the harness's answers, when the choices cannot hold them. */
  readonly answers: readonly string[];
  /** The choices that are the harness's own to remember. */
  readonly remembered: readonly string[];
  /** The start of the command that the grant choice names. */
  readonly grant: string | null;
  readonly notes: readonly RequestNote[];
  /** With the note `too_long`: how many characters the request has. */
  readonly size: number;
}

/** One field of a question that a harness asks its user, as Verifold read it. */
export interface QuestionShown {
  readonly type: 'question';
  readonly message: string;
  readonly field: string;
  readonly description: string;
  readonly kind: 'text' | 'number' | 'integer' | 'boolean' | 'choice' | 'choices';
  readonly options: readonly string[];
  readonly optional: boolean;
  readonly part: number;
  readonly parts: number;
}

export interface PostView {
  readonly seq: number;
  readonly at: string;
  readonly post: Post;
  readonly standing: Standing;
  /** The posts that build on this one, oldest first. */
  readonly built_on_by: readonly string[];
}

/** The lab's answer so far, which is the newest proposal in any thread, and each post that it builds on with where it stands. */
export interface AnswerView {
  readonly answer: PostView;
  /** Whether the person revised the question after this answer. */
  readonly to_earlier_question: boolean;
  readonly builds_on: readonly PostView[];
  /** How many of `builds_on` are results with files, which a blind checker can rerun. */
  readonly results: number;
  /** The results among them that no blind checker has rerun. */
  readonly no_blind_rerun: readonly string[];
}

/** A folder of the lab on the server's computer, and whether the server opened it in the file manager. */
export interface FolderView {
  readonly path: string;
  readonly opened: boolean;
}

/** The text of one file that backs a post, at the commit that the post pins. */
export interface FileText {
  readonly path: string;
  readonly commit: string;
  readonly text: string;
}

export interface ThreadView {
  readonly thread: Thread;
  readonly watching: boolean;
  /** The members of a side thread, in the order that they came. Empty for any other thread. */
  readonly members: readonly string[];
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

/** Ideas that crossed between two threads: posts in one build on another agent's posts in the other. */
export interface ThreadLink {
  /** The other thread. */
  readonly thread: string;
  /** The agents on the other side, each once. */
  readonly agents: readonly string[];
  /** How many times a post names a post across the two threads. */
  readonly count: number;
}

export interface ThreadSummary {
  readonly thread: Thread;
  readonly watching: boolean;
  /**
   * The members of a side thread, in the order that they came: the agents that it opened between, and each agent
   * that posted in it or watched it since. A post there reaches them only. Empty for any other thread.
   */
  readonly members: readonly string[];
  readonly posts: number;
  readonly last_at: string;
  readonly latest: PostLine | null;
  readonly disputed: number;
  readonly checked: number;
  readonly not_checked: number;
  readonly open_asks: number;
  /** How many calls in the thread still need an agent. */
  readonly open_calls: number;
  /** The agents that work in the thread now: each one whose latest plan or result is in it. */
  readonly team: readonly string[];
  /** The other threads whose posts, by other agents, this thread builds on most. */
  readonly builds_on_threads: readonly ThreadLink[];
  /** The other threads where other agents build most on the posts of this thread. */
  readonly built_on_by_threads: readonly ThreadLink[];
  /** How many times a post of this thread builds on another agent's post in another thread. */
  readonly crossed: number;
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

/** The harness of an agent that the person invited. It runs by itself, and Verifold starts nothing for it. */
export const GUEST = 'guest';

/** An invited agent, and the text that lets it join. The text holds the agent's token, and no later read returns it. */
export interface Invitation {
  readonly agent: string;
  readonly name: string;
  readonly text: string;
}
