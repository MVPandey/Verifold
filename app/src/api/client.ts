import type {
  LabView,
  PostRequest,
  PostView,
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
  post(request: PostRequest): Promise<PostView>;
  rerun(postId: string): Promise<void>;
  setTime(minutes: number): Promise<LabView>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Return the API of the server that served the app, as the person who holds `token`. */
export function createApi(
  token: string,
  fetcher: Fetch = (input, init) => fetch(input, init),
): Api {
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method: body === undefined ? 'GET' : 'POST',
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
    lab: () => request('/lab'),
    threads: () => request('/threads'),
    thread: (id) => request(`/threads/${encodeURIComponent(id)}`),
    needs: () => request('/needs'),
    post: (post) => request('/posts', post),
    rerun: async (postId) => {
      await request('/reruns', { post: postId });
    },
    setTime: (minutes) => request('/time', { minutes }),
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
