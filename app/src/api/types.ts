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
  | 'close'
  | 'request'
  | 'offer';
export type Standing = 'open' | 'checked' | 'held_up' | 'disputed' | 'conceded';

export interface ModelSpec {
  readonly family: string;
  readonly name: string | null;
  readonly effort: string | null;
}

/**
 * The one status of an agent or a thread, in the order of who needs the person. The first that applies is the
 * status: a permission request waits for the person, another ask to the person waits, the agent is in a turn, it
 * waits for another agent, it waits for nobody, Verifold stopped it, or it left.
 */
export type Need = 'approval' | 'answer' | 'working' | 'waiting' | 'idle' | 'stopped' | 'left';

export type Shape = 'square' | 'circle' | 'hex' | 'diamond' | 'arch' | 'triangle';
export type PictureSymbol =
  'wave' | 'dots' | 'arrow' | 'fork' | 'bars' | 'ring' | 'plus' | 'zigzag' | 'orbit' | 'slashes';

/** An agent's picture: one shape of six, one color of eight as a hex string, and one symbol of ten. */
export interface Picture {
  readonly shape: Shape;
  readonly color: string;
  readonly symbol: PictureSymbol;
}

/** A seat that an agent holds. */
export type SeatMark = 'coordinator' | 'reviewer' | 'on_call';

/** A post by its ID and its thread, so that the app can link to it. */
export interface PostRef {
  readonly id: string;
  readonly thread: string;
}

/** What became of an agent's posts, as lists of posts. It is no score and ranks nobody. */
export interface Outcomes {
  /** The agent's results that another agent built on. */
  readonly built_on: readonly PostRef[];
  /** The agent's results that a check holds up. */
  readonly held: readonly PostRef[];
  /** The agent's results that are disputed or conceded, and the leads that it ruled out. */
  readonly refuted: readonly PostRef[];
  /** The agent's asks that have no answer yet. */
  readonly open_asks: readonly PostRef[];
}

/** One change that the person or a coordinator made to an agent's profile, with the text from before. */
export interface ProfileEdit {
  readonly at: string;
  /** Who made the change: `person`, or the agent that held the coordinator seat. */
  readonly by: string;
  readonly part: 'name' | 'about' | 'picture' | 'role' | 'flag';
  /** The text that the part held before the change. For a picture, its three parts in words. */
  readonly before: string;
  readonly after: string;
}

/** One thing that waits for the person: an approval or an answer, with who asks, what, and since when. */
export interface Wait {
  readonly kind: 'approval' | 'answer';
  readonly agent: string;
  /** What waits, in one line. For a request of a harness, the words are Verifold's own. */
  readonly what: string;
  readonly since: string;
  readonly post: string;
  readonly thread: string;
}

/** Who wrote a post, as facts. `null` stands for the person. */
export interface Byline {
  /** The author's name now. */
  readonly name: string;
  /** The label of the author's seat as it was when the post was written. Empty when it is the author's name. */
  readonly seat: string;
  /** The seats that the author holds now. */
  readonly marks: readonly SeatMark[];
  readonly role: string;
}

export interface Agent {
  readonly id: string;
  /** The name that the agent chose, or else the label of its seat. */
  readonly name: string;
  readonly harness: string;
  readonly model: ModelSpec;
  readonly role: string;
  readonly brief: string;
  /** The role that the person gave the agent's seat when it joined. The view's `given_role` is the one of now. */
  readonly given_role: string;
  /** The harness mode that the person chose. `null` follows the lab's auto mode choice. */
  readonly mode: string | null;
  readonly recruited_by: string | null;
  /**
   * In a lab from before agents took reruns: the post that a checker reran blind. Verifold started such a checker
   * for a rerun request. `null` for every agent of a lab of today.
   */
  readonly checks: string | null;
}

/**
 * What an agent in the state `waiting` waits for. `person`: its harness waits for the person's answer inside a
 * turn that runs. `time`: the lab is out of time. `process`: the agent ended its turn and waits for a process
 * that it left running.
 */
export type WaitsFor = 'person' | 'time' | 'process';

export interface AgentActivity {
  readonly state: AgentState;
  /** The latest step that the harness reported, such as a tool call's title. */
  readonly detail: string;
  readonly at: string | null;
  /** With the state `waiting`: what the agent waits for. */
  readonly waits_for?: WaitsFor | null;
}

/**
 * The person's newest post in the conversation that a result of an agent's board tools carried to the agent. The
 * server that runs knows it, and the record does not hold it. It says nothing about what the agent made of the
 * post.
 */
export interface Heard {
  /** The post's place in the record. */
  readonly seq: number;
  /** When the result carried the post, or `null` when that was before this server started. */
  readonly at: string | null;
  /** Whether a result carried the whole post. `false` when the results carried only a line with a cut body. */
  readonly whole: boolean;
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
  /** With `by` the person: the coordinator, when it removed the agent with the power that the person switched on. */
  readonly through?: string | null;
  /** The coordinator's request that the removal came from, which holds the coordinator's reason. */
  readonly request?: string | null;
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
  /** The label of the agent's seat, such as "Codex · gpt-6.1-sol 2". It is the agent's name until it chooses one. */
  readonly seat: string;
  /** The name that the agent chose, or an empty text while it chose none. */
  readonly chosen_name: string;
  /** What lens the agent brings, in its own words. */
  readonly about: string;
  /** Who wrote the about line: the agent itself, or the coordinator that rewrote it. `null` without one. */
  readonly about_by: string | null;
  /**
   * Whether a turn of the agent runs now. A turn in which the harness waits for the person's answer runs. An
   * agent that waits for more time or for its own process is in no turn.
   */
  readonly in_turn: boolean;
  /** The picture that the agent chose, or `null`. */
  readonly picture: Picture | null;
  /** The role that somebody gave the agent's seat, or an empty string. */
  readonly given_role: string;
  /** Who gave it: `person`, or the agent that held the coordinator seat. `null` without a given role. */
  readonly given_by: string | null;
  /** Whether the agent holds a reviewer seat. */
  readonly reviewer: boolean;
  /** The reason of the coordinator's flag on the agent's profile, while one stands. */
  readonly flag: string;
  /** The changes that the person or a coordinator made to the agent's profile, oldest first. */
  readonly edits: readonly ProfileEdit[];
  /** The agent's one status. */
  readonly need: Need;
  readonly outcomes: Outcomes;
  /** What the agent says that it is to the lab, in its own words. */
  readonly role: string;
  /** Whether the person put the agent's seat on call, so that only a post for the agent itself wakes it. */
  readonly on_call: boolean;
  /** Whether the agent holds the lab's coordinator seat. */
  readonly coordinator: boolean;
  /** What the agent says that it does now. */
  readonly status: string;
  /** The thread where the agent works now, or `null` when it works in none. */
  readonly thread: string | null;
  readonly activity: AgentActivity;
  /** The person's newest post in the conversation that the agent's board tools carried to it, or `null`. */
  readonly heard: Heard | null;
  /** `null` while the agent is in the lab. */
  readonly left: AgentLeft | null;
  /** Whether Verifold stopped the agent because its harness failed too often. The person can start it again. */
  readonly stopped: boolean;
  readonly turns: number;
  /** How many turns of the agent started. It is above `turns` while a turn runs. */
  readonly turns_started: number;
  /** When the agent's last turn ended, or `null` when none ended. */
  readonly turn_ended_at: string | null;
  /** The alarm that waits for the agent, or `null`. */
  readonly alarm: AlarmLine | null;
  readonly posts: number;
  readonly usage: Usage;
  /** `null` when the harness reports tokens only. */
  readonly cost_usd: number | null;
  /** Why the agent's latest turn, or the latest start of its harness, failed, or `null`. */
  readonly error: string | null;
}

/** One version of the lab's question: the text that the lab opened with, or a revision by the person. */
export interface QuestionVersion {
  readonly question: string;
  readonly at: string;
  /** Why the question was revised, in the words of the one who revised it, or an empty text. */
  readonly note: string;
  /** The post that told the lab of the revision, or `null` for the first text. */
  readonly post: string | null;
  /** Who revised the question: `person`, or the coordinator under the power to revise it. */
  readonly by?: string;
  /** The coordinator's request that the revision came from, or `null` for the person's own revision. */
  readonly request?: string | null;
}

/**
 * A rerun that is wanted: somebody asked for an independent rerun of a post, and no check has answered it. An
 * independent rerun is a rerun from a clean copy of the post's files by another agent than the post's author.
 */
export interface RerunLine {
  readonly post: string;
  readonly thread: string;
  /** Who asked, each once, the first first: agents, or the person. */
  readonly asked_by: readonly string[];
  /** When the first of them asked. */
  readonly asked_at: string;
  /** The agents that took the rerun and have not posted its check yet. */
  readonly taken_by: readonly string[];
  /**
   * The leases that stand on the rerun, the oldest first. While one stands, the board refuses the rerun to every
   * other agent, except to an agent of another model family than the post while no holder is of another family.
   */
  readonly held_by: readonly LeaseLine[];
  /**
   * Who can take the rerun now: an agent in a reviewer seat, any agent that did not write the post, because no
   * agent in a reviewer seat can take it, or no agent of the lab.
   */
  readonly open_to: 'reviewer' | 'any' | 'none';
}

/** An agent's lease on a wanted rerun: who holds it, since when, and when it ends unless the holder renews it. */
export interface LeaseLine {
  readonly agent: string;
  readonly since: string;
  readonly until: string;
}

/** What a vote says about a post. `none` takes the voter's vote back. */
export type Direction = 'up' | 'down' | 'none';

/** A mark on a post, with who gave it and why. A `breakthrough` stands only after its second. */
export type Badge = 'promising' | 'confirmed' | 'breakthrough';

/** What a change does to a badge: give it, second a proposed `breakthrough`, or take it back. */
export type BadgeAction = 'give' | 'second' | 'take_back';

/** One standing vote on a post: who voted, which way, and why. Every vote counts the same. */
export interface VoteLine {
  /** The voter: an agent, or the person. */
  readonly by: string;
  readonly direction: 'up' | 'down';
  readonly reason: string;
  readonly at: string;
}

/** One giver's word for a badge: who gave or seconded it, why, and when. */
export interface Given {
  readonly by: string;
  readonly reason: string;
  readonly at: string;
  /** For `confirmed`: the check of the post that holds, which the giver named as what confirmed the post. */
  readonly proof?: string | null;
  /**
   * For `confirmed`: why this giver's word confirms the post no longer. A check of the post failed after the
   * check that confirmed it, or the author of that check conceded an objection to it. `null` while it does.
   */
  readonly lapsed?: 'later_check_failed' | 'check_conceded' | null;
}

/** One badge on a post, once, with every giver. A `breakthrough` has one giver, the agent that proposed it. */
export interface BadgeLine {
  readonly badge: Badge;
  readonly given: readonly Given[];
  /** For `breakthrough`: the second of the person, or of the coordinator that the person seated. */
  readonly second?: Given | null;
  /** Whether this is a `breakthrough` that an agent proposed and nobody seconded yet. */
  readonly waits?: boolean;
  /**
   * For a `breakthrough` that waits: the coordinator that can second it beside the person. The person gave it the
   * seat before the proposal, and it neither proposed the badge nor wrote the post. `null` when only the person can.
   */
  readonly seconder?: string | null;
  /** For `confirmed`: whether no giver's word confirms the post any longer, so that the post has no such badge. */
  readonly lapsed?: boolean;
}

/** A `breakthrough` that an agent proposed for a post and that nobody seconded yet. */
export interface ProposalLine {
  readonly post: string;
  readonly thread: string;
  /** The agent that proposed it. */
  readonly by: string;
  readonly reason: string;
  readonly at: string;
}

/** The person's change to a badge on a post. */
export interface BadgeRequest {
  readonly post: string;
  readonly badge: Badge;
  readonly action: BadgeAction;
  readonly reason?: string;
  /** With `take_back`: whose badge the person takes back. Without it, the person's own. */
  readonly giver?: string;
}

export interface LabView {
  /** The question that the lab works on now. */
  readonly question: string;
  /** Whether an agent may take the coordinator seat by itself: nobody holds it, and the person did not close it. */
  readonly coordinator_open: boolean;
  /** Every version of the question, oldest first. The last one is the current question. */
  readonly versions: readonly QuestionVersion[];
  readonly opened_at: string;
  readonly seq: number;
  readonly agents: readonly AgentView[];
  readonly threads: number;
  readonly posts: number;
  readonly needs_you: number;
  /** What waits for the person: the approvals first, then the answers, and in each the one that waits longest first. */
  readonly waits: readonly Wait[];
  /** The one status of each thread, by the thread's ID. */
  readonly thread_needs: Readonly<Record<string, Need>>;
  /** The reruns that are wanted, oldest first: who asked for each, when, and which agents took it. */
  readonly reruns_wanted: readonly RerunLine[];
  /** Each `breakthrough` that waits for its second, oldest first. It is none of `waits` and changes no status. */
  readonly proposals: readonly ProposalLine[];
  /** The threads that hold a post with a `breakthrough` that stands. */
  readonly breakthrough_threads: readonly string[];
  /** How many reviewer seats the lab has. */
  readonly reviewer_seats: number;
  /** The number that the person set, or `null` while the number follows the size of the lab. */
  readonly reviewer_seats_set: number | null;
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
  /** What the person wants to hold at the end of the lab, each with its state and the offers for it. */
  readonly deliverables: readonly Deliverable[];
  /** The deliverables that the person removed after agents offered files for them, each with its thread. */
  readonly removed_deliverables: readonly RemovedDeliverable[];
  /** When a post of the person last told the lab of a new sentence or a removal, or `null`. */
  readonly deliverables_told_at: string | null;
  /** Every obstacle of the lab's lines of work, the newest first. */
  readonly obstacles: readonly Obstacle[];
}

/**
 * Where an obstacle stands, by the posts that build on it, as `ObstacleState` in the server's `protocol/join.py`.
 * `open`: no plan and no result builds on it. `taken_up`: one does, and no result that builds on it stands.
 * `removed`: a result that builds on it stands.
 */
export type ObstacleState = 'open' | 'taken_up' | 'removed';

/** A post as an obstacle's line shows it: where it is, who wrote it, its kind, and its headline. */
export type ObstacleLine = Pick<PostLine, 'id' | 'thread' | 'author' | 'kind' | 'text'>;

/** An obstacle: a ruled-out post of a line of work, when it came, where it stands as a post, and its state. */
export interface Obstacle {
  readonly post: ObstacleLine;
  readonly at: string;
  readonly standing: Standing;
  readonly state: ObstacleState;
  /** For `removed`, the results that build on it and stand. For `taken_up`, the plans and results that build on it. */
  readonly builders: readonly ObstacleLine[];
}

/** Where a deliverable stands, by the lab's record. Only the person's acceptance makes it `accepted`. */
export type DeliverableState = 'none' | 'offered' | 'changes_asked' | 'accepted';

/** One agent's offer of files for a deliverable, as it stands. */
export interface DeliverableOffer {
  /** The post that holds the offer. Each file opens at the commit that the post pins. */
  readonly post: string;
  readonly by: string;
  readonly at: string;
  /** The agent's note on the offer. */
  readonly note: string;
  /** The detail of the offer's post. */
  readonly body?: string;
  readonly files: readonly string[];
  /** How many earlier offers of the same agent for this deliverable this one replaced. */
  readonly revised: number;
  /** What the person decided about this offer: nothing yet, a request for changes, or an acceptance that stands. */
  readonly state: 'waiting' | 'changes_asked' | 'accepted';
  /** When the person accepted the offer or asked for changes, while `state` says so. */
  readonly decided_at: string | null;
  /** Where the offer's post stands after the objections and checks to it. */
  readonly standing: Standing;
  /** While the offer is disputed: the newest failed check or objection to it that still stands. */
  readonly disputed_by: string | null;
  /** While the offer is conceded: the objection to it that its author accepted. */
  readonly conceded_to: string | null;
}

/** A deliverable: the person's sentence, its state, and each agent's newest offer. */
export interface Deliverable {
  readonly id: string;
  readonly text: string;
  readonly state: DeliverableState;
  /** When the person accepted an offer or asked for changes, while the state says so. */
  readonly decided_at: string | null;
  /** The thread that holds the offers, or `null` until the first offer opens it. */
  readonly thread: string | null;
  readonly offers: readonly DeliverableOffer[];
  /** The other posts of the thread that stand disputed: an earlier offer, or what an agent said there. */
  readonly disputed: readonly string[];
  /** The asks in the thread that no answer replies to. */
  readonly open_asks: readonly string[];
}

/** A deliverable that the person removed after agents offered files for it. Its thread stays on the board. */
export interface RemovedDeliverable {
  readonly id: string;
  /** The sentence that the deliverable had last. */
  readonly text: string;
  readonly removed_at: string;
  readonly thread: string;
  /** Whether a post came to the thread after the removal. The wall then shows the thread as a card. */
  readonly active: boolean;
}

/** What the person decides about an offer. */
export type DeliverableDecision = 'accept' | 'ask_changes' | 'take_back';

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

export interface ReviewerSettings {
  /** The number of reviewer seats, from 0 to 20. `null` follows the size of the lab. */
  readonly seats: number | null;
}

export interface VoteSettings {
  /**
   * For how many minutes after a post was written an agent sees no votes on it until it votes itself. The author
   * and the person see them at once. Zero seals no vote.
   */
  readonly reveal_minutes: number;
}

export interface RerunSettings {
  /** How many minutes a take of a rerun, or its renewal, holds the lease on it. */
  readonly lease_minutes: number;
}

export interface Settings {
  readonly version: number;
  readonly jobs: JobSettings;
  readonly permissions: PermissionSettings;
  readonly reviewers: ReviewerSettings;
  readonly votes: VoteSettings;
  readonly reruns: RerunSettings;
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
  | 'jobs.at_time_limit'
  | 'jobs.at_exit'
  | 'permissions.while_you_decide'
  | 'reviewers.seats'
  | 'votes.reveal_minutes'
  | 'reruns.lease_minutes'
  | 'setup';

/**
 * The person changes one setting. A `null` value removes it, so the one for all projects, or Verifold's default,
 * applies. The change names both files' revisions, because the files add up.
 */
export interface SettingsChange {
  readonly level: SettingsLevel;
  readonly key: SettingKey;
  readonly value: string | number | SetupChoices | null;
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
  /** The facts of the seat. A file from before seats had facts holds none. */
  readonly role?: string;
  readonly family?: string | null;
  readonly on_call?: boolean;
  readonly coordinator?: boolean;
}

/** What new labs start with unless the person chooses otherwise. */
export interface SetupDefaults {
  /** The seats of a new lab. A harness can have several. `null` starts one agent of each harness that this computer has. */
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
  /** The role that the person gives the seat, as one line of at most 40 characters. */
  readonly role?: string;
  /** The model family of the seat's model. Without it, the seat has the family of its harness. */
  readonly family?: string;
  /** Whether the seat is on call: only a post for the agent itself wakes it. */
  readonly on_call?: boolean;
  /** Whether the seat's agent is the lab's coordinator. Such a seat has one agent. */
  readonly coordinator?: boolean;
  /** The powers that the person switches on for the coordinator from the start. Only the coordinator's seat has any. */
  readonly powers?: readonly Power[];
}

/** The person invites an agent that runs by itself, and can state the facts of its seat. */
export interface InviteRequest {
  readonly name?: string;
  readonly role?: string;
  readonly family?: string;
  readonly on_call?: boolean;
  readonly coordinator?: boolean;
}

/** The person changes an agent's seat. A part that is left out stays as it is. */
export interface SeatChange {
  readonly on_call?: boolean;
  readonly coordinator?: boolean;
  /** Give the agent a reviewer seat, or take the seat that it holds. */
  readonly reviewer?: boolean;
}

/** The person changes an agent's profile: takes back what the agent chose, or gives its seat a role. */
export interface ProfileChange {
  /** Take the agent's chosen name back, so that its seat's label is its name again. */
  readonly reset_name?: boolean;
  readonly reset_about?: boolean;
  readonly reset_picture?: boolean;
  /** The role that the person gives the seat, as one line of at most 40 characters. An empty text takes it back. */
  readonly role?: string;
}

export interface StartRequest {
  readonly question: string;
  readonly agents: readonly AgentChoice[];
  readonly auto_mode: boolean;
  readonly minutes?: number;
  /** What the person wants to hold at the end of the lab, each as one sentence. */
  readonly deliverables?: readonly string[];
}

export interface Thread {
  readonly id: string;
  readonly title: string;
  readonly opened_by: string;
  /** For the thread that Verifold opened for an agent's requests of one kind: that kind. */
  readonly carries?: 'permission' | 'question' | null;
  /** Whether this is the thread where the person and the lab's coordinator talk. */
  readonly conversation?: boolean;
  /** Whether the lab's coordinator opened the thread for the person. */
  readonly for_person?: boolean;
  /** For the thread that holds the offers of files for one deliverable: that deliverable. */
  readonly deliverable?: string | null;
}

/** A kind of move that the person can hand to the lab's coordinator. Each one is off until the person switches it on. */
export type Power = 'time' | 'permissions' | 'agents' | 'settings' | 'question';

/** A move that only the person makes, and that the lab's coordinator can ask the person for. */
export type Move =
  | { readonly type: 'time'; readonly minutes: number }
  /** `option` is the harness's own ID of one of its answers on the ask. */
  | { readonly type: 'permission'; readonly ask: string; readonly option: string }
  | { readonly type: 'add_agent'; readonly seat: AddSeat }
  | { readonly type: 'remove_agent'; readonly agent: string }
  | {
      readonly type: 'setting';
      readonly key: 'jobs.at_time_limit' | 'jobs.at_exit';
      readonly value: string;
    }
  | { readonly type: 'question'; readonly question: string; readonly note: string };

/**
 * The seat of the one agent that a move adds. It holds nothing else: no model family, no mode, no coordinator
 * mark, no power, and no reviewer seat.
 */
export interface AddSeat {
  readonly harness: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly on_call: boolean;
  /** A role that the coordinator gives the seat, or an empty string. It is the coordinator's word. */
  readonly role: string;
}

/** The answer to a coordinator's request for a move: the person's yes or no, or the yes of a power that is on. */
export interface RequestAnswered {
  readonly at: string;
  readonly request: string;
  readonly yes: boolean;
  /** `person`, or the coordinator itself while the person's power for this kind of move is on. */
  readonly by: string;
  /** With the person's yes to more time: the minutes that the person gave, when not the minutes of the request. */
  readonly minutes: number | null;
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
  /** Whether the post is for the whole lab. Only the lab's coordinator and the person can mark a post so. */
  readonly to_lab?: boolean;
  /** Whether the lab's coordinator posted this for the person. Only the coordinator can mark a post so. */
  readonly for_person?: boolean;
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
      /** The coordinator's request that this answer carries out. Verifold sets it, and no agent can. */
      readonly for_request?: string | null;
    })
  | (PostBase & {
      /** The coordinator's request to the person for a move. `text` and `body` hold the reason. */
      readonly kind: 'request';
      readonly move: Move;
    })
  | (PostBase & {
      /** An agent's offer of files for a deliverable of the person. `text` is the agent's note. */
      readonly kind: 'offer';
      readonly deliverable: string;
    })
  | (PostBase & {
      readonly kind: 'check';
      readonly outcome: 'holds' | 'fails';
      readonly method: 'rerun' | 'code_read' | 'ratings';
      /**
       * The event with which the author took the rerun of the post, when this is the check of that take. The
       * author was given the clean copy of the post's pinned files, and the check's files are its own. Verifold
       * sets it, and no agent can.
       */
      readonly take?: number | null;
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
  /** The start of the command that the grant choice names. With it, the ask's last choice is Verifold's grant. */
  readonly grant: string | null;
  /** The harness's ID of each of its answers among the ask's choices, in their order. */
  readonly ids: readonly string[];
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
  /** Whether Verifold cut the harness's text, because it is too long to record. */
  readonly cut: boolean;
}

export interface PostView {
  readonly seq: number;
  readonly at: string;
  readonly post: Post;
  /** Who wrote the post. `null` for a post of the person. */
  readonly by: Byline | null;
  readonly standing: Standing;
  /** The posts that build on this one, oldest first. */
  readonly built_on_by: readonly string[];
  /** For a request for a move: its answer, or `null` while it has none. */
  readonly decision?: RequestAnswered | null;
  /** For a request for a move: whether it waits for the person's answer. */
  readonly waits?: boolean;
  /**
   * For a request for a move without an answer: why it waits for none. `seat`: the coordinator seat changed after
   * it. `ask`: the permission request that it answers got its answer or ended. `null` while it waits.
   */
  readonly ended?: 'seat' | 'ask' | null;
  /** How many votes up and down stand on the post. */
  readonly up?: number;
  readonly down?: number;
  /** The newest standing votes with their reasons, oldest first. */
  readonly votes?: readonly VoteLine[];
  /** Each badge on the post once, with who gave it. A `breakthrough` that waits for its second says so. */
  readonly badges?: readonly BadgeLine[];
}

/** One power of the coordinator as the person sees it. */
export interface PowerView {
  readonly power: Power;
  readonly on: boolean;
  /** When the person switched it on, or `null` while it is off. */
  readonly since: string | null;
  /** How many moves the agent that holds the seat made with it. */
  readonly used: number;
}

/** A move that came from a request of the coordinator: with the person's yes, or under a power. */
export interface Deed {
  /** The request, with its answer in `decision`. */
  readonly request: PostView;
  /** For a move that added an agent: that agent. */
  readonly agent: string | null;
  /** The way back that the person has now, or `null` when there is none. */
  readonly undo: 'remove_agent' | 'take_minutes' | null;
}

/** What the panel for the coordinator shows: the conversation, the powers, and what was done for the person. */
export interface ConversationView {
  /** The agent that holds the coordinator seat, or `null`. */
  readonly coordinator: string | null;
  /** The thread where the person and the coordinator talk, or `null` while the lab has none. */
  readonly thread: ThreadView | null;
  /** The posts of that thread that wait for the person's answer. */
  readonly waits: readonly string[];
  /** The permission requests that the requests in the conversation name. */
  readonly asks: readonly PostView[];
  /** Every power, in a fixed order. */
  readonly powers: readonly PowerView[];
  /** The moves that came from the coordinator's requests, newest first. */
  readonly deeds: readonly Deed[];
}

/** The lab's answer so far, which is the newest proposal in any thread, and each post that it builds on with where it stands. */
export interface AnswerView {
  readonly answer: PostView;
  /** Whether the person revised the question after this answer. */
  readonly to_earlier_question: boolean;
  readonly builds_on: readonly PostView[];
  /** How many of `builds_on` are results with files, which an agent can rerun from a clean copy. */
  readonly results: number;
  /** The results among them that have no check of an independent rerun. The name is from before agents took reruns. */
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
  /**
   * For the thread of the offers for a deliverable: the agents that the person's post there reaches when it names
   * nobody. When the list is empty, such a post is for every agent that is not on call. `null` for any other thread.
   */
  readonly person_reaches?: readonly string[] | null;
  readonly posts: readonly PostView[];
}

export interface PostLine {
  readonly id: string;
  readonly thread: string;
  readonly author: string;
  readonly kind: PostKind;
  readonly text: string;
  /** A line leaves out each field that holds nothing, so the post that it replies to and its author's line can be absent. */
  readonly reply_to?: string | null;
  readonly seq: number;
  readonly at: string;
  /** Who the author is. Absent for a post of the person. */
  readonly by?: Byline | null;
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
  /** When the newest result of a line of work came. `null` without one, and for any other thread. */
  readonly last_result_at: string | null;
  /** How many obstacles of a line of work are open: ruled-out posts that no plan and no result builds on. */
  readonly open_obstacles: number;
}

export interface PostRequest {
  readonly kind: PostKind;
  readonly text: string;
  readonly body?: string;
  readonly thread?: string;
  readonly new_thread?: string;
  readonly reply_to?: string;
  readonly mentions?: readonly string[];
  /** On an answer: the choice of the ask that the person pressed. Words that they typed are in the text. */
  readonly choice?: string;
  /** Whether the post goes in the conversation with the coordinator, in place of `thread` and `new_thread`. */
  readonly conversation?: boolean;
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

/** The files of the lab folder that hold the norms. */
export type NormsName = 'LAB.md' | 'WRITING.md';

/** One norms file as the Norms page shows it. */
export interface NormsFile {
  readonly name: NormsName;
  readonly path: string;
  readonly text: string;
  /** `false` when the folder has no such file yet, so `text` is the default that a new lab gets. */
  readonly saved: boolean;
  /** A hash of `text`. A save names it, so that it can't write over a text that the person didn't see. */
  readonly revision: string;
  /** Why the server can't read the file. The page then shows no text for it. */
  readonly error: string | null;
  /** When the file last changed, or `null` when the folder has no such file. */
  readonly changed_at: string | null;
  /** Who wrote the file's text: this page, or somebody outside it. `null` when the server can't tell. */
  readonly changed_by: 'page' | 'outside' | null;
  /** The lines of the current default norms that the file does not have. */
  readonly missing: readonly string[];
}

/** Why a save put no post on the board. */
export type NoPost = 'same' | 'no_lab' | 'no_thread' | 'close' | 'told_already' | 'refused';

/** The lab's norms: how the person wants the work done, and how the lab writes its answer. */
export interface NormsView {
  readonly files: readonly NormsFile[];
  /** After a save: the person's post that tells the agents of the change, also when an earlier save posted it. */
  readonly told: string | null;
  /** After a save that put no post on the board: why. */
  readonly no_post: NoPost | null;
}
