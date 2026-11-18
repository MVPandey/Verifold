import type {
  AgentChoice,
  BadgeRequest,
  BudgetRequest,
  CandidatesView,
  ConversationView,
  DeskView,
  Direction,
  DeliverableDecision,
  FileText,
  FolderView,
  Invitation,
  InviteRequest,
  LabView,
  NormsName,
  NormsView,
  PostRequest,
  PostView,
  Power,
  ProfileChange,
  SeatChange,
  SettingsChange,
  SettingsView,
  SetupView,
  StartRequest,
  ThreadSummary,
  ThreadView,
} from './types.ts';

/** The candidates of a lab where no agent has proposed an answer. */
export const NO_CANDIDATES: CandidatesView = { standing: [], gone: [], closes_on: null };

/** A request that the server refused, with the server's reason. */
export class ApiError extends Error {
  /** The HTTP status, or 0 when the server never answered. */
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** The person's calls to the app API. Each one carries the person's token. */
export interface Api {
  setup(): Promise<SetupView>;
  start(request: StartRequest): Promise<SetupView>;
  lab(): Promise<LabView>;
  threads(): Promise<readonly ThreadSummary[]>;
  thread(id: string): Promise<ThreadView>;
  needs(): Promise<readonly PostView[]>;
  /** The newest report that an agent wrote for the person, or `null` when the lab has none. */
  report(): Promise<PostView | null>;
  /** The candidate answers with what each builds on, and the one that a close closes on. */
  candidates(): Promise<CandidatesView>;
  /** The text of a file that backs a post. */
  file(postId: string, path: string): Promise<FileText>;
  /**
   * Ask the server to open the folder where the agents work, or one agent's folder, in its file manager. The
   * answer holds the path also when nothing opened.
   */
  openFolder(agentId?: string): Promise<FolderView>;
  post(request: PostRequest): Promise<PostView>;
  rerun(postId: string): Promise<void>;
  /** Vote on a post with a reason of one line, or take the vote back with `none`. The answer is the post after it. */
  vote(postId: string, direction: Direction, reason: string): Promise<PostView>;
  /** Give a post a badge, second a Breakthrough badge that an agent proposed, or take a badge back. */
  badge(request: BadgeRequest): Promise<PostView>;
  setTime(minutes: number): Promise<LabView>;
  /** Set the lab's budget. It replaces the earlier one, and a kind that is left out has no budget. */
  setBudget(budget: BudgetRequest): Promise<LabView>;
  /** Set the lab's disk limit in gigabytes. Zero means no limit. */
  setDisk(limitGb: number): Promise<LabView>;
  /** Revise the lab's question. `note` says why, and it can be empty. */
  reviseQuestion(question: string, note: string): Promise<LabView>;
  /** State one more deliverable: what the person wants to hold at the end of the lab, as one sentence. */
  addDeliverable(text: string): Promise<LabView>;
  /** Give a deliverable another sentence. The record keeps the earlier one. */
  changeDeliverable(id: string, text: string): Promise<LabView>;
  /** Remove a deliverable. Its offers stay on the board as posts. */
  removeDeliverable(id: string): Promise<LabView>;
  /**
   * Decide about an offer of files for a deliverable: accept it, ask its author for changes, or take the
   * acceptance back. `text` says what to change, and the offer's author gets it as a reply.
   */
  decideDeliverable(
    id: string,
    decision: DeliverableDecision,
    offer: string,
    text?: string,
  ): Promise<LabView>;
  /** Add the agents of one seat to the lab that runs. */
  addAgents(choice: AgentChoice): Promise<LabView>;
  /** Put an agent's seat on call or take it off, and give or take the coordinator seat or a reviewer seat. */
  changeSeat(agentId: string, change: SeatChange): Promise<LabView>;
  /** Take back the name, the about line, or the picture that an agent chose, or give its seat a role. */
  changeProfile(agentId: string, change: ProfileChange): Promise<LabView>;
  /** Set how many reviewer seats the lab has. `null` follows the size of the lab again. */
  setReviewerSeats(seats: number | null): Promise<LabView>;
  /** Leave the coordinator seat without a holder, open for an agent to take or closed. */
  setCoordinatorSeat(open: boolean): Promise<LabView>;
  /** Ask the harnesses that Verifold did not ask yet what they offer. The setup shows the answers when they come. */
  askOffers(): Promise<SetupView>;
  /** Invite an agent that runs by itself. Without a name, it gets the next one, such as "Agent 3". */
  invite(request?: InviteRequest): Promise<Invitation>;
  /** Give an invited agent a new token, which makes its earlier token void. */
  inviteAgain(agentId: string): Promise<Invitation>;
  /** Remove an agent from the lab, for good. Its posts stay. */
  removeAgent(agentId: string): Promise<LabView>;
  /** Start an agent that Verifold stopped because its harness failed too often. */
  startAgain(agentId: string): Promise<LabView>;
  /** The conversation with the coordinator, the coordinator's powers, and what was done for the person. */
  conversation(): Promise<ConversationView>;
  /** The desk chat, and what the desk did on the person's word. */
  desk(): Promise<DeskView>;
  /** Switch a power of the coordinator on or off. */
  setPower(power: Power, on: boolean): Promise<ConversationView>;
  /** Answer a request of the coordinator for a move. `minutes` gives another amount of time than the request names. */
  answerRequest(postId: string, yes: boolean, minutes?: number): Promise<ConversationView>;
  /** Take back the minutes that a request for more time gave the lab. */
  takeMinutesBack(postId: string): Promise<ConversationView>;
  settings(): Promise<SettingsView>;
  changeSetting(change: SettingsChange): Promise<SettingsView>;
  /** The lab's norms files, or before a lab starts the defaults that the new lab gets. */
  norms(): Promise<NormsView>;
  /**
   * Save a new text for one norms file. `revision` is the file's revision when the person read it, and the server
   * refuses the save with status 409 when the file changed since. In a lab, a post from the person tells the
   * agents of the change.
   */
  saveNorms(name: NormsName, text: string, revision: string): Promise<NormsView>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Return the API of the server that served the app, as the person who holds `token`. */
export function createApi(
  token: string,
  fetcher: Fetch = (input, init) => fetch(input, init),
): Api {
  async function request<T>(path: string, body?: unknown, method?: 'DELETE'): Promise<T> {
    const init: RequestInit = {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetcher(`/api${path}`, init).catch((failure: unknown) => {
      // fetch fails only when the request never got an answer, such as when verifold has stopped.
      throw new ApiError(0, "Can't reach verifold. Check that it is still running.", {
        cause: failure,
      });
    });
    if (!response.ok) throw new ApiError(response.status, await reason(response));
    // The server validates every response against its Pydantic schema, which `types.ts` mirrors.
    return (await response.json()) as T;
  }

  return {
    setup: () => request('/setup'),
    start: (start) => request('/labs', start),
    lab: () =>
      // A server from before these fields sends none, and the page must still load.
      request<LabView>('/lab').then((lab) => ({
        ...lab,
        versions: lab.versions ?? [],
        coordinator_open: lab.coordinator_open ?? true,
        state: lab.state ?? 'open',
        close: lab.close ?? null,
        close_agreed: lab.close_agreed ?? 0,
        close_among: lab.close_among ?? lab.agents.filter((view) => !view.agent.checks).length,
        waits: lab.waits ?? [],
        thread_needs: lab.thread_needs ?? {},
        reruns_wanted: lab.reruns_wanted ?? [],
        proposals: lab.proposals ?? [],
        breakthrough_threads: lab.breakthrough_threads ?? [],
        reviewer_seats: lab.reviewer_seats ?? 0,
        reviewer_seats_set: lab.reviewer_seats_set ?? null,
        deliverables: lab.deliverables ?? [],
        removed_deliverables: lab.removed_deliverables ?? [],
        deliverables_told_at: lab.deliverables_told_at ?? null,
        obstacles: lab.obstacles ?? [],
        agents: lab.agents.map((view) => ({
          ...view,
          agent: { ...view.agent, given_role: view.agent.given_role ?? '' },
          seat: view.seat || (view.agent.name ?? ''),
          chosen_name: view.chosen_name ?? '',
          about: view.about ?? '',
          about_by: view.about_by ?? null,
          in_turn: view.in_turn ?? view.activity?.state === 'working',
          picture: view.picture ?? null,
          given_role: view.given_role ?? view.agent.given_role ?? '',
          given_by: view.given_by ?? null,
          reviewer: view.reviewer ?? false,
          flag: view.flag ?? '',
          edits: view.edits ?? [],
          need: view.need ?? 'idle',
          outcomes: view.outcomes ?? { built_on: [], held: [], refuted: [], open_asks: [] },
          turns_started: view.turns_started ?? view.turns,
          role: view.role ?? '',
          on_call: view.on_call ?? false,
          coordinator: view.coordinator ?? false,
          error: view.error ?? null,
          status: view.status ?? '',
          thread: view.thread ?? null,
          heard: view.heard ?? null,
          left: view.left ?? null,
          stopped: view.stopped ?? false,
        })),
      })),
    threads: () =>
      // A server from before these fields sends none, and the page must still load.
      request<readonly ThreadSummary[]>('/threads').then((threads) =>
        threads.map((summary) => ({
          ...summary,
          builds_on_threads: summary.builds_on_threads ?? [],
          built_on_by_threads: summary.built_on_by_threads ?? [],
          crossed: summary.crossed ?? 0,
          open_calls: summary.open_calls ?? 0,
          team: summary.team ?? [],
          members: summary.members ?? [],
          last_result_at: summary.last_result_at ?? null,
          open_obstacles: summary.open_obstacles ?? 0,
        })),
      ),
    thread: (id) =>
      // A server from before side threads sends no members.
      request<ThreadView>(`/threads/${encodeURIComponent(id)}`).then((view) => ({
        ...view,
        members: view.members ?? [],
      })),
    needs: () => request('/needs'),
    report: () => request('/report'),
    // A server from before this route has none, and the page must still load.
    candidates: () =>
      request<CandidatesView>('/candidates').catch((failure: unknown) => {
        if (failure instanceof ApiError && failure.status === 404) return NO_CANDIDATES;
        throw failure;
      }),
    file: (postId, path) =>
      request(`/posts/${encodeURIComponent(postId)}/file?path=${encodeURIComponent(path)}`),
    openFolder: (agentId) => request('/folder', agentId ? { agent: agentId } : {}),
    post: (post) => request('/posts', post),
    rerun: async (postId) => {
      await request('/reruns', { post: postId });
    },
    vote: (postId, direction, reason) => request('/votes', { post: postId, direction, reason }),
    badge: (change) => request('/badges', change),
    setTime: (minutes) => request('/time', { minutes }),
    setBudget: (budget) => request('/budget', budget),
    setDisk: (limitGb) => request('/disk', { limit_gb: limitGb }),
    reviseQuestion: (question, note) => request('/question', { question, note }),
    addDeliverable: (text) => request('/deliverables', { text }),
    changeDeliverable: (id, text) => request(`/deliverables/${encodeURIComponent(id)}`, { text }),
    removeDeliverable: (id) =>
      request(`/deliverables/${encodeURIComponent(id)}`, undefined, 'DELETE'),
    decideDeliverable: (id, decision, offer, text) =>
      request(`/deliverables/${encodeURIComponent(id)}/decision`, {
        decision,
        offer,
        ...(text ? { text } : {}),
      }),
    addAgents: (choice) => request('/agents', choice),
    changeSeat: (agentId, change) => request(`/agents/${encodeURIComponent(agentId)}/seat`, change),
    changeProfile: (agentId, change) =>
      request(`/agents/${encodeURIComponent(agentId)}/profile`, change),
    setReviewerSeats: (seats) => request('/reviewers', { seats }),
    setCoordinatorSeat: (open) => request('/coordinator', { open }),
    askOffers: () => request('/offers', {}),
    invite: (invitation) => request('/invitations', invitation ?? {}),
    inviteAgain: (agentId) => request(`/invitations/${encodeURIComponent(agentId)}`, {}),
    removeAgent: (agentId) =>
      request(`/agents/${encodeURIComponent(agentId)}`, undefined, 'DELETE'),
    startAgain: (agentId) => request(`/agents/${encodeURIComponent(agentId)}/start`, {}),
    conversation: () => request('/conversation'),
    desk: () => request('/desk'),
    setPower: (power, on) => request('/powers', { power, on }),
    answerRequest: (postId, yes, minutes) =>
      request(`/requests/${encodeURIComponent(postId)}`, {
        yes,
        ...(minutes === undefined ? {} : { minutes }),
      }),
    takeMinutesBack: (postId) => request(`/requests/${encodeURIComponent(postId)}/minutes`, {}),
    settings: () => request('/settings'),
    changeSetting: (change) => request('/settings', change),
    norms: () => request('/norms'),
    saveNorms: (name, text, revision) => request('/norms', { name, text, revision }),
  };
}

async function reason(response: Response): Promise<string> {
  const fallback = `The server refused the request (${response.status}).`;
  try {
    const payload: unknown = await response.json();
    const detail =
      typeof payload === 'object' && payload !== null && 'detail' in payload
        ? payload.detail
        : undefined;
    if (typeof detail === 'string') return detail;
    // A schema error from FastAPI is a list of problems. The first one says what to fix.
    const first: unknown = Array.isArray(detail) ? detail[0] : undefined;
    const message =
      typeof first === 'object' && first !== null && 'msg' in first ? first.msg : undefined;
    return typeof message === 'string' ? message : fallback;
  } catch {
    return fallback;
  }
}

/** Return the text of an error, for the person to read. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Reload the page.';
}
