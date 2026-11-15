import type {
  AgentChoice,
  AnswerView,
  FileText,
  FolderView,
  Invitation,
  LabView,
  NormsName,
  NormsView,
  PostRequest,
  PostView,
  SettingsChange,
  SettingsView,
  SetupView,
  StartRequest,
  ThreadSummary,
  ThreadView,
} from './types.ts';

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
  /** The lab's answer so far with what it builds on, or `null` when no agent has proposed one. */
  answer(): Promise<AnswerView | null>;
  /** The text of a file that backs a post. */
  file(postId: string, path: string): Promise<FileText>;
  /**
   * Ask the server to open the folder where the agents work, or one agent's folder, in its file manager. The
   * answer holds the path also when nothing opened.
   */
  openFolder(agentId?: string): Promise<FolderView>;
  post(request: PostRequest): Promise<PostView>;
  rerun(postId: string): Promise<void>;
  setTime(minutes: number): Promise<LabView>;
  /** Revise the lab's question. `note` says why, and it can be empty. */
  reviseQuestion(question: string, note: string): Promise<LabView>;
  /** Add agents of one harness to the lab that runs. */
  addAgents(choice: AgentChoice): Promise<LabView>;
  /** Invite an agent that runs by itself. Without a name, it gets the next one, such as "Agent 3". */
  invite(name?: string): Promise<Invitation>;
  /** Give an invited agent a new token, which makes its earlier token void. */
  inviteAgain(agentId: string): Promise<Invitation>;
  /** Remove an agent from the lab, for good. Its posts stay. */
  removeAgent(agentId: string): Promise<LabView>;
  /** Start an agent that Verifold stopped because its harness failed too often. */
  startAgain(agentId: string): Promise<LabView>;
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
        state: lab.state ?? 'open',
        close: lab.close ?? null,
        close_agreed: lab.close_agreed ?? 0,
        close_among: lab.close_among ?? lab.agents.filter((view) => !view.agent.checks).length,
        agents: lab.agents.map((view) => ({
          ...view,
          role: view.role ?? '',
          status: view.status ?? '',
          thread: view.thread ?? null,
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
    answer: () =>
      request<AnswerView | null>('/answer').catch((failure: unknown) => {
        if (failure instanceof ApiError && failure.status === 404) return null;
        throw failure;
      }),
    file: (postId, path) =>
      request(`/posts/${encodeURIComponent(postId)}/file?path=${encodeURIComponent(path)}`),
    openFolder: (agentId) => request('/folder', agentId ? { agent: agentId } : {}),
    post: (post) => request('/posts', post),
    rerun: async (postId) => {
      await request('/reruns', { post: postId });
    },
    setTime: (minutes) => request('/time', { minutes }),
    reviseQuestion: (question, note) => request('/question', { question, note }),
    addAgents: (choice) => request('/agents', choice),
    invite: (name) => request('/invitations', name ? { name } : {}),
    inviteAgain: (agentId) => request(`/invitations/${encodeURIComponent(agentId)}`, {}),
    removeAgent: (agentId) =>
      request(`/agents/${encodeURIComponent(agentId)}`, undefined, 'DELETE'),
    startAgain: (agentId) => request(`/agents/${encodeURIComponent(agentId)}/start`, {}),
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
