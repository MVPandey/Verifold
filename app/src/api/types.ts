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
  | 'reading'
  | 'summary'
  | 'call'
  | 'task'
  | 'hand_back'
  | 'close'
  | 'request'
  | 'offer'
  | 'round'
  | 'entry'
  | 'action'
  | 'receipt'
  | 'measure'
  | 'headline_number'
  | 'dashboard'
  | 'idea';
export type Standing = 'open' | 'checked' | 'held_up' | 'disputed' | 'conceded';

/**
 * How checks tested a result, beside where it stands: a rerun of its own files holds, a challenge on something
 * that its author did not use holds, or such a challenge fails.
 */
export type Tested = 'reproduced' | 'challenged' | 'challenge_failed';

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
export type SeatMark = 'coordinator' | 'reviewer' | 'on_call' | 'desk' | 'acting';

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
  /** What waits, in one line. For a request of a harness or an action, the words are Verifold's own. */
  readonly what: string;
  readonly since: string;
  readonly post: string;
  readonly thread: string;
}

/** An ask or an action for the person that stopped waiting before the person answered, so nothing was done for it. */
export interface Missed extends Wait {
  /** When it stopped waiting. */
  readonly ended_at: string;
}

/**
 * Where an action stands. `allowed`: its allowance allowed it. `waits`: it waits for the person until its offer
 * ends. `yes` and `no`: the person answered. `missed`: its offer ended without an answer, so nothing was done.
 */
export type ActionState = 'allowed' | 'waits' | 'yes' | 'no' | 'missed';

/**
 * Why an action waits for the person: its seat holds no allowance in force, its cost is above the bound for one
 * action, or it would take the allowance past its total.
 */
export type ActionNeed = 'none' | 'per_action' | 'total';

/**
 * What an allowance lets its holder do. Amounts are decimal strings in `unit`, as the server sends them, so the app
 * shows them as the record holds them.
 */
export interface AllowanceTerms {
  readonly holder: string;
  readonly purpose: string;
  readonly unit: string;
  readonly per_action: string;
  readonly total: string;
  readonly ends_at: string;
  /** The cost above which an action needs a check by another agent first, or `null`. */
  readonly check_above: string | null;
}

/** One action of an acting seat: what it does, what it can lose, and where it stands. */
export interface ActionView {
  readonly post: string;
  readonly thread: string;
  readonly agent: string;
  readonly at: string;
  readonly what: string;
  readonly cost: string;
  readonly undoable: boolean;
  readonly offer_ends: string;
  readonly state: ActionState;
  readonly needs: ActionNeed | null;
  /** What it cost by its newest receipt, or `null` until a receipt comes. */
  readonly real_cost: string | null;
  readonly receipt: string | null;
}

/**
 * Where an allowance stands. `draft`: it waits for the person's confirmation. `in_force`: it allows actions now.
 * `over`: its end time came. `ended`: the person ended it. `replaced`: the person started a newer one for the seat.
 */
export type AllowanceState = 'draft' | 'in_force' | 'over' | 'ended' | 'replaced';

/** An allowance with its terms, where it stands, what it allowed, and its actions, the newest first. */
export interface AllowanceView {
  readonly allowance: string;
  readonly terms: AllowanceTerms;
  readonly state: AllowanceState;
  readonly drafted_at: string;
  /** Who drafted it: `person`, or the desk on the person's word. */
  readonly by: string;
  readonly on: string | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  /** What the allowance allowed so far, as a decimal string. */
  readonly drawn: string;
  /** Whether its actions passed its total, so that the board stopped the holder until the person decides. */
  readonly stopped: boolean;
  readonly actions: readonly ActionView[];
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
 * turn that runs. `time`: the lab is out of time. `limit`: the lab reached its budget or its disk limit.
 * `process`: the agent ended its turn and waits for a process that it left running. `retry`: its harness failed,
 * and Verifold starts it again at the time in `retry`. `pace`: a pause or a limit of tokens per hour holds its
 * next turn.
 */
export type WaitsFor = 'person' | 'time' | 'limit' | 'process' | 'retry' | 'pace';

/** A harness that failed and that Verifold starts again. */
export interface Retry {
  /** How many times in a row the harness failed. The agent's `error` is the last one. */
  readonly failures: number;
  /** When Verifold starts the harness again. */
  readonly at: string;
  /** Whether the error says that the provider limits the harness, such as a rate limit or a usage limit. */
  readonly provider_limit: boolean;
}

export interface AgentActivity {
  readonly state: AgentState;
  /**
   * Verifold's words for what the agent does: in a turn, the kind of the latest tool call that the harness reported,
   * such as "Runs a command", or nothing for a call of another kind. While it waits, what it waits for.
   */
  readonly detail: string;
  readonly at: string | null;
  /** With the state `waiting`: what the agent waits for. */
  readonly waits_for?: WaitsFor | null;
  /** While the agent waits for `retry`: how its harness failed, and when Verifold starts it again. */
  readonly retry?: Retry | null;
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

/** A limit of the lab other than its time. */
export type Limit = 'tokens' | 'dollars' | 'disk';

/**
 * The lab's budget, what it spent, and what is left, from the ends of its turns. A harness that reports no cost
 * adds no dollars.
 */
export interface BudgetLine {
  /** The budget in tokens, or `null` for none. */
  readonly tokens: number | null;
  /** The budget in US dollars, or `null` for none. */
  readonly dollars: number | null;
  readonly spent_tokens: number;
  readonly spent_dollars: number;
  readonly tokens_left: number | null;
  readonly dollars_left: number | null;
}

/** The bytes that the lab's files take on disk, as Verifold measured them at the end of a turn. */
export interface DiskUse {
  readonly at: string;
  /** Each agent's folder, by agent. */
  readonly folders: Readonly<Record<string, number>>;
  /** The clean copies for reruns. */
  readonly reruns: number;
  /** The snapshots of the agents' folders. */
  readonly snapshots: number;
  readonly total: number;
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
  /** The notes that the agent keeps for its own seat, whole. Empty while it keeps none. */
  readonly notes: string;
  /** When the agent last changed its notes, or `null` while it keeps none. */
  readonly notes_at: string | null;
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
  /** Whether the agent's seat is the lab's desk, which answers the person in the desk chat. Absent from older views. */
  readonly desk?: boolean;
  /** Whether the agent's seat is an acting seat, which acts in the world with a key of its own. */
  readonly acting?: boolean;
  /** The harness mode of the seat now. `null` follows the lab's auto mode choice. */
  readonly mode?: string | null;
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
  /**
   * The usage limits of the provider behind the seat, as its harness reported them last, without a window whose
   * reset time passed. `null` when its harness reported none.
   */
  readonly limits: SeatLimits | null;
  /** The pause of the seat while one stands. Only a post of the person for it starts its next turn then. */
  readonly pause: PauseLine | null;
  /** The lowest limit of tokens per hour that holds the seat, with this hour's tokens. The lab's limit is apart. */
  readonly cap: CapLine | null;
}

/** The status of a provider's usage limit: it takes the seat's requests, it warns that a limit is near, or it refuses them. */
export type LimitStatus = 'allowed' | 'warning' | 'reached';

/** One window of a provider's usage limit: how much of it the seat's account used, and when it starts again. */
export interface LimitWindow {
  /** The window in the words that the person reads after "of the", such as "5-hour" or "weekly". */
  readonly label: string;
  readonly used_percent: number;
  readonly resets_at: string | null;
}

/** The usage limits of the provider behind a seat, as its harness reported them last. */
export interface SeatLimits {
  readonly windows: readonly LimitWindow[];
  readonly status: LimitStatus | null;
}

/** A pause of a seat that stands. The server leaves out each part that holds nothing. */
export interface PauseLine {
  /** `person`, or the coordinator under the person's power for pace. */
  readonly by: string;
  readonly since: string;
  /** When the pause ends. Absent while it lasts until somebody resumes the seat. */
  readonly until?: string | null;
  readonly why?: string;
}

/** The limit of tokens for one hour of the clock that holds a seat or the lab, and what this hour spent of it. */
export interface CapLine {
  readonly tokens_per_hour: number;
  /** The tokens of the turns that ended in this hour. Absent for none. */
  readonly spent?: number;
  readonly hour_ends: string;
  readonly by: string;
  readonly why?: string;
  /** Whether the limit is the person's setting for the coordinator's seat. Absent when it is not. */
  readonly share?: boolean;
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
  /** The lab's budget, what it spent, and what is left. */
  readonly budget: BudgetLine;
  /** The budget or the disk limit that the lab reached. Its agents wait until the person raises it. */
  readonly limit: Limit | null;
  /** What the lab's files take on disk, as Verifold measured them last. `null` before the first measure. */
  readonly disk: DiskUse | null;
  /** The lab's limit of tokens per hour, with this hour's tokens of every seat, or `null` while none stands. */
  readonly lab_cap: CapLine | null;
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
  /** The round that is open, or else the newest round that closed. `null` in a lab without rounds. */
  readonly round: RoundView | null;
  /** The drafts that wait for the person's confirmation, and every allowance that the person started, newest first. */
  readonly allowances?: readonly AllowanceView[];
  /** When the person paused every action, while the pause stands. */
  readonly actions_paused?: string | null;
  /** The asks and actions that stopped waiting before the person answered, the newest first. */
  readonly missed?: readonly Missed[];
  /** The lab's headline number, or `null` while nobody named one. An older server sends none. */
  readonly headline_number?: HeadlineView | null;
  /** The version of the dashboard that stands, or `null` while the lab has none. */
  readonly dashboard?: DashboardMeta | null;
  /** The labels that the lab's measures have, each once, in the order that they came. */
  readonly measure_labels?: readonly string[];
}

/**
 * One measure: its number, the time that it holds for, its author, and who reran it. `rerun_by` names the agents
 * whose check of an independent rerun of it holds, and `rerun_failed_by` the ones whose such check fails. The marks
 * never say whether the number is good.
 */
export interface MeasureView {
  readonly post: string;
  readonly thread: string;
  readonly by: string;
  readonly label: string;
  /** The number as an exact decimal string. */
  readonly value: string;
  readonly unit: string;
  readonly as_of: string;
  readonly rerun_by: readonly string[];
  readonly rerun_failed_by: readonly string[];
  readonly standing: Standing;
}

/** The lab's headline number: its label, who named it, and the newest measure with that label, or `null`. */
export interface HeadlineView {
  readonly label: string;
  /** The post that named the label. */
  readonly post: string;
  /** The person, or the agent that held the coordinator seat. */
  readonly named_by: string;
  readonly named_at: string;
  /** The coordinator's one line of why. Empty for the person's naming. */
  readonly why: string;
  readonly measure: MeasureView | null;
}

/** The version of the dashboard that stands: its post, its page's path, its author, when it came, and its size. */
export interface DashboardMeta {
  readonly post: string;
  readonly thread: string;
  readonly path: string;
  readonly by: string;
  readonly at: string;
  readonly size: number;
  readonly standing: Standing;
  /** How many versions of the dashboard the lab has, this one among them. */
  readonly versions: number;
}

/** The version of the dashboard that stands, with the text of its page. */
export interface DashboardPage {
  readonly meta: DashboardMeta;
  readonly html: string;
}

/** Why a round closed: its time came, every agent that it waited for entered, or its opener withdrew it. */
export type RoundEnd = 'time' | 'entered' | 'opener';

/** Verifold's record that a round closed. */
export interface RoundClosed {
  readonly type: 'round_closed';
  readonly seq: number;
  readonly at: string;
  readonly round: string;
  readonly why: RoundEnd;
}

/**
 * A round as the lab page shows it: the round, when it closes, its entries, and the agents that did not enter. The
 * person sees every entry whole as it arrives. The agents see one another's entries only from the close on.
 */
export interface RoundView {
  readonly round: PostView;
  /** Whether the round is open now by the lab's clock. */
  readonly open: boolean;
  readonly closes_at: string;
  /** The close, with when and why. `null` until Verifold records it. */
  readonly closed: RoundClosed | null;
  /** The entries, oldest first. */
  readonly entries: readonly PostView[];
  /** The agents that the round waits for now, or waited for at its close, that did not enter. */
  readonly not_entered: readonly string[];
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

export interface TaskSettings {
  /** How many minutes a claim of a task, or the holder's activity on it, holds the lease on it. */
  readonly lease_minutes: number;
}

export interface DiskSettings {
  /** The most gigabytes that the lab's files may take before the agents stop. Zero means no limit. */
  readonly limit_gb: number;
}

export interface PaceSettings {
  /** The most tokens that the coordinator's seat may spend in one hour of the clock. Zero means no limit. */
  readonly coordinator_tokens_per_hour: number;
}

export interface Settings {
  readonly version: number;
  readonly jobs: JobSettings;
  readonly permissions: PermissionSettings;
  readonly reviewers: ReviewerSettings;
  readonly votes: VoteSettings;
  readonly reruns: RerunSettings;
  /** Absent from a server from before tasks. */
  readonly tasks?: TaskSettings;
  readonly disk: DiskSettings;
  /** Absent from a server from before pace. */
  readonly pace?: PaceSettings;
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
  | 'tasks.lease_minutes'
  | 'disk.limit_gb'
  | 'pace.coordinator_tokens_per_hour'
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
  /** What the harness says of the value, in its own words. Absent when it says nothing. */
  readonly description?: string;
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
  /**
   * The sentence of the record of findings: the deliverable that a new lab starts with while
   * `defaults.findings_record` holds.
   */
  readonly findings_deliverable: string;
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
  readonly desk?: boolean;
  readonly acting?: boolean;
}

/** What new labs start with unless the person chooses otherwise. */
export interface SetupDefaults {
  /** The seats of a new lab. A harness can have several. `null` starts one agent of each harness that this computer has. */
  readonly agents: readonly SavedChoice[] | null;
  readonly auto_mode: boolean;
  /** `null` means no time limit. */
  readonly minutes: number | null;
  /** The budget in tokens. `null` means none. */
  readonly budget_tokens: number | null;
  /** The budget in US dollars. `null` means none. */
  readonly budget_dollars: number | null;
  /** Whether a new lab starts with the record of findings among its deliverables. */
  readonly findings_record: boolean;
}

/** The choices for new labs, as the app saves them. */
export interface SetupChoices {
  readonly agents: readonly AgentChoice[];
  readonly auto_mode: boolean;
  readonly minutes: number | null;
  readonly budget_tokens: number | null;
  readonly budget_dollars: number | null;
  readonly findings_record: boolean;
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
  /** Whether the seat is the lab's desk. A lab has one, its seat has one agent, and it holds no other seat. */
  readonly desk?: boolean;
  /** Whether the seat is an acting seat. It is not the coordinator and not the desk. */
  readonly acting?: boolean;
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
  /** Make the seat an acting seat, or take the mark back. */
  readonly acting?: boolean;
  /** One of the harness's own modes. The seat's session starts again in it before its next turn. */
  readonly mode?: string;
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
  readonly budget_tokens?: number;
  readonly budget_dollars?: number;
  /** What the person wants to hold at the end of the lab, each as one sentence. */
  readonly deliverables?: readonly string[];
}

/** The person sets the lab's budget. It replaces the earlier one, and a kind that is left out has no budget. */
export interface BudgetRequest {
  readonly tokens?: number;
  readonly dollars?: number;
}

export interface Thread {
  readonly id: string;
  readonly title: string;
  readonly opened_by: string;
  /** For the thread that Verifold opened for an agent's requests of one kind: that kind. */
  readonly carries?: 'permission' | 'question' | null;
  /** Whether this is the thread where the person and the lab's coordinator talk. */
  readonly conversation?: boolean;
  /** Whether the lab's coordinator, or the desk, opened the thread for the person. */
  readonly for_person?: boolean;
  /** For the thread that holds the offers of files for one deliverable: that deliverable. */
  readonly deliverable?: string | null;
  /** Whether this is the desk chat, where the person and the desk talk. Absent when it is not. */
  readonly desk?: boolean;
}

/** A kind of move that the person can hand to the lab's coordinator. Each one is off until the person switches it on. */
export type Power = 'time' | 'permissions' | 'agents' | 'settings' | 'question' | 'pace';

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
  | { readonly type: 'question'; readonly question: string; readonly note: string }
  | PaceMove;

/**
 * A move of pace: a pause of a seat until `until`, or with `null` until a resume; the end of a pause; or a limit of
 * tokens for one hour, for one seat with `agent` or for the whole lab without it. `null` tokens take a limit back.
 */
export type PaceMove =
  | {
      readonly type: 'pause';
      readonly agent: string;
      readonly until?: string | null;
      readonly why?: string;
    }
  | { readonly type: 'resume'; readonly agent: string; readonly why?: string }
  | {
      readonly type: 'cap';
      readonly agent?: string | null;
      readonly tokens_per_hour?: number | null;
      readonly why?: string;
    };

/**
 * The seat of the one agent that a move adds. It holds nothing else: no model family, no coordinator mark, no
 * power, and no reviewer seat.
 */
export interface AddSeat {
  readonly harness: string;
  readonly model: string | null;
  readonly effort: string | null;
  /** One of the harness's own modes. Absent for the lab's own mode. */
  readonly mode?: string | null;
  readonly on_call: boolean;
  /** A role that the coordinator gives the seat, or an empty string. It is the coordinator's word. */
  readonly role: string;
  /** Whether the seat starts with a fresh view: no candidate and no report until its first plan. */
  readonly fresh?: boolean;
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
  /** Whether the lab's coordinator, or the desk, posted this for the person. Only they can mark a post so. */
  readonly for_person?: boolean;
  /** For the desk's post for the person: the person's post in the desk chat that it rests on. Absent otherwise. */
  readonly on?: string;
  /** For the person's message in the desk chat: the thread that the person had open. Absent otherwise. */
  readonly about?: string;
  /** For the coordinator's round, reading, or naming of the headline number: its one line of why. Absent otherwise. */
  readonly why?: string;
  /** For a plan or a result: the idea that it tries. For a ruled-out lead: the idea that it rules out. */
  readonly idea?: string;
  /** For a reading: the branches of the question that it adds. Absent otherwise. */
  readonly branches?: readonly Branch[];
  /** For a reading: the branches in force that it retires. Absent otherwise. */
  readonly retires?: readonly string[];
}

/** A branch of the question, which a reading adds: its ID, such as `b-2`, and its short title. */
export interface Branch {
  readonly id: string;
  readonly title: string;
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
        | 'reading'
        | 'summary'
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
      /** When the ask stops waiting for the person, as its author set it. Absent when it waits until an answer. */
      readonly ends_at?: string;
    })
  | (PostBase & {
      readonly kind: 'answer';
      readonly accepts: boolean;
      /** Whether Verifold ended the harness's request that the ask carries, without the person's answer. */
      readonly ends_request?: boolean;
      /** The coordinator's request that this answer carries out. Verifold sets it, and no agent can. */
      readonly for_request?: string | null;
      /** Whether the request ended before the person could answer it, with the agent's turn or a restart. */
      readonly missed?: boolean;
    })
  | (PostBase & {
      /** An action that an acting seat declares before it does it. `text` says what. */
      readonly kind: 'action';
      /** The most that the action can lose, with its fees, as a decimal string in its allowance's unit. */
      readonly cost: string;
      readonly undoable: boolean;
      readonly offer_ends: string;
      /** The allowance that the author held when it declared the action, or `null`. Verifold sets it. */
      readonly allowance: string | null;
      /** Whether that allowance allowed the action at once. */
      readonly allowed: boolean;
      /** Why the action waits for the person, or `null` for one that its allowance allowed. */
      readonly needs: ActionNeed | null;
    })
  | (PostBase & {
      /** What an action did, from its author, with the action in `reply_to`. `text` says what happened. */
      readonly kind: 'receipt';
      /** What the action cost, with its fees, as a decimal string. */
      readonly cost: string;
    })
  | (PostBase & {
      /**
       * One number that an agent reports, with the script that produced it and that script's output in
       * `evidence`. Verifold writes `text` from the label, the value, and the unit.
       */
      readonly kind: 'measure';
      readonly label: string;
      /** The number as an exact decimal string. */
      readonly value: string;
      readonly unit: string;
      /** The time that the number holds for. */
      readonly as_of: string;
      readonly script: string;
      readonly output: string;
    })
  | (PostBase & {
      /** The label of the lab's headline number from now on. An empty label takes it back. */
      readonly kind: 'headline_number';
      readonly label: string;
    })
  | (PostBase & {
      /** One version of the lab's dashboard: the page that `evidence` pins, with its size in bytes. */
      readonly kind: 'dashboard';
      readonly size: number;
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
      /** A question to every agent at once, which `text` holds. It stays open for `minutes`. */
      readonly kind: 'round';
      readonly minutes: number;
    })
  | (PostBase & {
      /** An agent's answer to a round, which `reply_to` names. */
      readonly kind: 'entry';
    })
  | (PostBase & {
      /** One way to answer the question, stated with its test before anyone tries it. `text` is the statement. */
      readonly kind: 'idea';
      /** The branch, such as `b-2`, or the idea, such as `p-14`, that it hangs on. `null` for an idea on no branch yet. */
      readonly parent: string | null;
      /** How the idea is tested. */
      readonly test: string;
      /** What result of the test would rule it out. */
      readonly rules_out: string;
    })
  | (PostBase & {
      /** One piece of work for one agent. `text` is its objective. */
      readonly kind: 'task';
      /** The output wanted. */
      readonly output: string;
      /** What the work stays within. */
      readonly bounds: string;
    })
  | (PostBase & {
      /** The work of a task, from the agent that claimed it, which `reply_to` names. `text` says what was done. */
      readonly kind: 'hand_back';
      /** What the work found, or an empty string. */
      readonly findings: string;
      /** What its author doubts about the work, or an empty string. */
      readonly concerns: string;
      /** Where the work left the task's brief, or an empty string. */
      readonly deviations: string;
    })
  | (PostBase & {
      readonly kind: 'check';
      readonly outcome: 'holds' | 'fails';
      /** `challenge`: the author tested the claim on something that the post's author did not use. */
      readonly method: 'rerun' | 'code_read' | 'ratings' | 'challenge';
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
  /** For a result: how checks tested it. Absent in a view from before the field. */
  readonly tested?: readonly Tested[];
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
  /** For a task: its state and who holds it. Absent for every other post. */
  readonly task?: TaskView | null;
}

/**
 * Where a task stands: `open` while nobody holds it, `claimed` while an agent's lease stands, `handed_back` while
 * the work that came back waits, `done` once its author accepted the work or a check of it holds, and `withdrawn`
 * once its author withdrew it.
 */
export type TaskState = 'open' | 'claimed' | 'handed_back' | 'done' | 'withdrawn';

/** A task's state and the claim that stands, as a view of the task's post has them. */
export interface TaskView {
  /** Absent while it is `open`. */
  readonly state?: TaskState;
  /** The claim that stands, with when its lease ends. Absent while nobody holds the task. */
  readonly held_by?: LeaseLine | null;
  /** The newest work that came back for it and counts. */
  readonly hand_back?: string | null;
}

/** A task of a thread as the thread's card shows it: what it asks for, and who is on it now. */
export interface TaskCard {
  readonly task: string;
  readonly author: string;
  /** The task's objective, as a line shows its headline. */
  readonly text: string;
  readonly state: TaskState;
  /** The agent on the work: the holder of a claimed task, or the agent whose work came back. */
  readonly agent: string | null;
  /** When the holder's lease ends, unless a post of the holder starts it again. */
  readonly until: string | null;
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
  /**
   * The person's posts in that thread that wait for the coordinator's reply, oldest first. A post of the person,
   * other than an answer, waits until an agent posts in the thread after it while that agent holds the coordinator
   * seat.
   */
  readonly no_reply: readonly string[];
  /** The permission requests that the requests in the conversation name. */
  readonly asks: readonly PostView[];
  /** Every power, in a fixed order. */
  readonly powers: readonly PowerView[];
  /** The moves that came from the coordinator's requests, newest first. */
  readonly deeds: readonly Deed[];
  /** The log of the coordinator's moves, newest first. An older server sends none. */
  readonly moves?: readonly MoveView[];
  /** The person's grant of spare seats while one stands. An older server sends none. */
  readonly grant?: SpareSeats | null;
}

/** The kinds of the coordinator's moves: a move from its request, a round, a reading, or a headline number. */
export type SteerKind =
  | 'time'
  | 'permission'
  | 'add_agent'
  | 'remove_agent'
  | 'setting'
  | 'question'
  | 'pause'
  | 'resume'
  | 'cap'
  | 'round'
  | 'reading'
  | 'headline_number';

/** One move of the coordinator, in the log of its moves. */
export interface MoveView {
  /** The post that holds the move: the request that got a yes, the round, or the reading. */
  readonly post: PostView;
  readonly kind: SteerKind;
  /** When the move took effect. */
  readonly at: string;
  /** The agent that held the coordinator seat. */
  readonly by: string;
  /** The coordinator's one line of why. */
  readonly why: string;
  /** The seat that the move names, or `null`. */
  readonly agent: string | null;
  /** For a move from a request: who said yes, the person or the coordinator. */
  readonly yes_by: string | null;
}

/** One kind of seat that the person's grant lets the coordinator add. `null` is the harness's default. */
export interface SeatChoice {
  readonly harness: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly mode: string | null;
}

/** The person's grant of spare seats as the person sends it. Zero seats take the grant back. */
export interface SeatGrant {
  readonly seats: number;
  readonly choices: readonly SeatChoice[];
}

/** The grant of spare seats that stands: the seats left, how many the person granted, and the kinds. */
export interface SpareSeats {
  readonly left: number;
  readonly of: number;
  readonly kinds: readonly SeatChoice[];
}

/** What the desk did on the person's word. */
export type DeskDeed =
  'post' | 'round' | 'question' | 'deliverable' | 'time' | 'budget' | 'interrupt' | 'allowance';

/** One action of the desk, with the person's post in the desk chat that it rests on. */
export interface DeskAction {
  readonly on: string;
  readonly at: string;
  readonly kind: DeskDeed;
  /** The post that the action made: the desk's post for the person, its round, or the post that tells the lab. */
  readonly post: string | null;
  readonly thread: string | null;
  /** For the end of a turn: the agent whose turn the desk ended. */
  readonly agent: string | null;
  /** For a change of a deliverable: its ID, and what the desk did to it. */
  readonly deliverable: string | null;
  readonly change: 'added' | 'changed' | 'removed' | null;
  /** For a new end of the lab: the end that the desk set. */
  readonly ends_at: string | null;
  /** For a new budget: the budget in tokens and in dollars that the desk set, `null` for a kind without one. */
  readonly tokens?: number | null;
  readonly dollars?: number | null;
  /** For a draft of an allowance: its ID. The draft allows nothing until the person confirms it. */
  readonly allowance?: string | null;
}

/** What the panel for the desk shows: the desk, the desk chat, and what the desk did on the person's word. */
export interface DeskView {
  /** The agent that holds the desk seat, or `null` while the lab has none. */
  readonly desk: string | null;
  /** The desk chat, or `null` while the lab has none. */
  readonly thread: ThreadView | null;
  /** Each action of the desk, oldest first. */
  readonly actions: readonly DeskAction[];
}

/** A candidate answer: an agent's newest proposal, and each post that it builds on with where it stands. */
export interface CandidateView {
  readonly candidate: PostView;
  /** Whether the person revised the question after this candidate. */
  readonly to_earlier_question: boolean;
  readonly builds_on: readonly PostView[];
  /** How many of `builds_on` are results with files, which an agent can rerun from a clean copy. */
  readonly results: number;
  /** The results among them that have no check of an independent rerun. The name is from before agents took reruns. */
  readonly no_blind_rerun: readonly string[];
  /** The results that the candidate builds on directly, counted by how each stands. `null` when it builds on none. */
  readonly rests_on?: RestsOn | null;
  /** The author's own entry of a round that the candidate builds on. Its detail and files are the candidate's too. */
  readonly entry: PostView | null;
}

/**
 * The results that a candidate builds on directly, each once, by how each stands: a challenge holds, only a rerun
 * holds, only other checks hold, nothing checked it, it is disputed, or its author conceded it. A count of zero is
 * absent, and the counts add up to the number of those results.
 */
export interface RestsOn {
  readonly challenged?: number;
  readonly reproduced_only?: number;
  readonly checked_otherwise?: number;
  readonly not_checked?: number;
  readonly disputed?: number;
  readonly conceded?: number;
}

/** The candidate answers that stand, oldest first, and the one that the close that stands closes on. */
export interface CandidatesView {
  readonly standing: readonly CandidateView[];
  /** The proposals that stand no more, oldest first: conceded, with the standing `conceded`, or replaced. */
  readonly gone: readonly PostView[];
  /** While the lab is closed, this candidate is the lab's answer. `null` while no close names one. */
  readonly closes_on: CandidateView | null;
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
  /**
   * The thread's summary: its newest summary, while no failed check and no standing objection disputes it and its
   * author conceded no objection to it. Absent while the thread has none.
   */
  readonly summary?: string | null;
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
  /** The thread's summary, while it has one that stands, as a line with its headline. Absent otherwise. */
  readonly summary?: PostLine | null;
  readonly disputed: number;
  readonly checked: number;
  readonly not_checked: number;
  /** How many results of the thread stand and have a challenge that holds. Absent while it is zero. */
  readonly challenged?: number;
  /** How many results of the thread stand and have a rerun that holds and no challenge that holds. Absent at zero. */
  readonly reproduced_only?: number;
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
  /** The thread's tasks that are open, claimed, or handed back, oldest first. */
  readonly tasks: readonly TaskCard[];
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
  /** On a round: how many minutes it stays open, from 1 to 15. */
  readonly minutes?: number;
  /** On a message in the desk chat: the thread that the person has open, which the message is about. */
  readonly about?: string;
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

/** Where an idea stands, by the record. The board computes it, and no agent sets it. */
export type IdeaState = 'untried' | 'being_tried' | 'result_in' | 'challenged' | 'ruled_out';

/** One branch of the question with counts of the record. A count of zero, and a false mark, are absent. */
export interface BranchLine {
  readonly id: string;
  readonly title: string;
  readonly ideas?: number;
  readonly untried?: number;
  readonly being_tried?: number;
  readonly results?: number;
  readonly ruled_out?: number;
  /** The plans and results that tried its ideas in the last 3 hours. */
  readonly recent_tries?: number;
  /** For a branch without an idea: the hours since the reading that added it. */
  readonly no_idea_hours?: number | null;
  /** The newest measure that names the branch, as a line that leaves out each field that holds its default. */
  readonly measure?: BranchMeasure | null;
  readonly retired?: boolean;
}

/** The newest measure of a branch. A field that holds its default is absent. */
export type BranchMeasure = Pick<
  MeasureView,
  'post' | 'thread' | 'by' | 'label' | 'value' | 'as_of'
> &
  Partial<Pick<MeasureView, 'unit' | 'rerun_by' | 'rerun_failed_by' | 'standing'>>;

/** A plan or a result that tries an idea. */
export interface TryLine {
  readonly post: string;
  readonly thread: string;
  readonly kind: 'plan' | 'result';
  readonly author: string;
  readonly text: string;
  readonly at: string;
  readonly standing?: Standing;
}

/** A check with the method `challenge` of a result that tries an idea. */
export interface ChallengeLine {
  readonly post: string;
  readonly thread: string;
  /** The result that the check tests. */
  readonly result: string;
  readonly author: string;
  readonly text: string;
  readonly outcome: 'holds' | 'fails';
}

/** An idea on the map, with its test, what rules it out, its tries, and where it stands. */
export interface IdeaView {
  readonly id: string;
  readonly thread: string;
  readonly author: string;
  readonly at: string;
  readonly text: string;
  readonly parent?: string | null;
  readonly branch?: string | null;
  readonly state?: IdeaState;
  readonly test?: string;
  readonly rules_out?: string;
  readonly tries?: readonly TryLine[];
  readonly challenges?: readonly ChallengeLine[];
  readonly ruled_out_by?: readonly string[];
  readonly sealed?: boolean;
}

/** A branch on the map: its counts, the readings that added and retired it, and its ideas in the order posted. */
export interface BranchView extends BranchLine {
  readonly added_by: string;
  readonly retired_by?: string | null;
  readonly idea_list?: readonly IdeaView[];
}

/** The map of the lab: the branches in force in the readings' order, then the retired ones, then the ideas on none. */
export interface MapView {
  readonly branches: readonly BranchView[];
  /** The ideas that hang on no branch, in the order posted: an idea without a parent, and the ideas on such an idea. */
  readonly no_branch?: readonly IdeaView[];
  /** How many ideas hang on no branch. */
  readonly ideas_without_branch?: number;
  /** How many ideas of the open round are sealed for the agents. The person's map shows them whole. */
  readonly sealed: number;
  readonly left_out: number;
}
