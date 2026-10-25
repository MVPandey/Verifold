import { turnIdPattern } from '../protocol/api.ts';
import type { SetupPage } from './setup.ts';

/**
 * The app's pages, from the URL fragment. The lab home is `#/`, a direction
 * is `#/d/<id>`, one turn of its agent is `#/d/<id>/turn/<turn>`, a call
 * opens over the page that opened it at `#/call/<id>`, the answer is
 * `#/answer`, and a direction's bring-in is `#/d/<id>/bring`. `#/board/<id>`
 * is the lab home with a post of its board brought into view, and
 * `#/post/<id>` is a post's own page, with its replies. `#/d/<id>/run/<run>`
 * is a direction's page with a run marked in the turn that started it. The
 * first run is `#/setup/<step>`, and `#/setup` opens its first step without
 * a record. While Verifold runs without a project, `#/new` asks whether
 * the new project uses the global settings or its own, `#/ask` asks the
 * question of a new project, and `#/project/setup/<step>` and
 * `#/project/ask` do the same for an isolated project, with its own
 * profile. `#/run/<id>` is a run's own page, `#/agent/<id>` an agent's
 * page, such as a checker's, with its turns at `#/agent/<id>/turn/<turn>`,
 * and `#/d/<id>/diff` what a direction changed, or with a proof such as
 * `#/d/<id>/diff/p-12.0` the diff that a post cites. `#/figure/p-12.0` is a
 * figure that a post cites, with its post. `#/settings` is the project's
 * settings, with its pods. Any other fragment is a page that does not
 * exist.
 */
export type Route =
  | {
      readonly page: 'lab';
      /** A post of the board to bring into view. */
      readonly post?: string;
    }
  | {
      readonly page: 'direction';
      readonly direction: string;
      /** A run to bring into view. */
      readonly run?: string;
    }
  | {
      readonly page: 'turn';
      readonly direction: string;
      readonly turn: string;
    }
  | {
      readonly page: 'call';
      readonly id: string;
      /** The page that opened the call, from its history entry. Without one, the call shows over the lab home. */
      readonly opener?: Opener;
    }
  | { readonly page: 'post'; readonly id: string }
  /** The proof that a post cites, such as p-12.0. */
  | { readonly page: 'figure'; readonly proof: string }
  | { readonly page: 'answer' }
  | { readonly page: 'bring'; readonly direction: string }
  | {
      readonly page: 'setup';
      /** Null: the first step without a record, or the end. */
      readonly step: SetupPage | null;
      /** `project`: the own profile of an isolated project that starts. */
      readonly scope?: 'project';
    }
  | {
      readonly page: 'ask';
      /** `project`: an isolated project, with its own profile. */
      readonly scope?: 'project';
    }
  /** Without a project: the global settings, or an isolated project. */
  | { readonly page: 'new' }
  | { readonly page: 'run'; readonly id: string }
  | { readonly page: 'agent'; readonly id: string }
  | {
      readonly page: 'agent-turn';
      readonly agent: string;
      readonly turn: string;
    }
  | {
      readonly page: 'diff';
      readonly direction: string;
      /** The proof that a post cites, such as p-12.0. Without one, the direction's changes since its start. */
      readonly proof?: string;
    }
  | { readonly page: 'settings' }
  | { readonly page: 'history' }
  /** One run of History: `current`, or an archive ID. */
  | { readonly page: 'history-run'; readonly id: string }
  | { readonly page: 'start-over' }
  | { readonly page: 'unknown' };

/** A page that a call can show over: any page but a call. */
export type PageRoute = Exclude<Route, { readonly page: 'call' }>;

/** The page that opened a call, from the call's history entry. */
export interface Opener {
  /** Its address, such as `#/d/d-2`. */
  readonly hash: string;
  readonly route: PageRoute;
  /** Close can go Back to the opener's entry without loading the app again. */
  readonly back: boolean;
}

/** A direction ID, such as d-2. It starts with a letter or digit, so ".." is never one. */
const id = '[A-Za-z0-9][A-Za-z0-9._-]{0,99}';

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '' || path === '/') return { page: 'lab' };
  const call = /^\/call\/(c-[1-9][0-9]{0,5})$/.exec(path);
  if (call?.[1]) return { page: 'call', id: call[1] };
  const board = /^\/board\/(p-[1-9][0-9]{0,5})$/.exec(path);
  if (board?.[1]) return { page: 'lab', post: board[1] };
  const post = /^\/post\/(p-[1-9][0-9]{0,5})$/.exec(path);
  if (post?.[1]) return { page: 'post', id: post[1] };
  const figure = /^\/figure\/(p-[1-9][0-9]{0,5}\.[0-9])$/.exec(path);
  if (figure?.[1]) return { page: 'figure', proof: figure[1] };
  const direction = new RegExp(`^/d/(${id})$`).exec(path);
  if (direction?.[1]) return { page: 'direction', direction: direction[1] };
  const bring = new RegExp(`^/d/(${id})/bring$`).exec(path);
  if (bring?.[1]) return { page: 'bring', direction: bring[1] };
  const run = new RegExp(`^/d/(${id})/run/(r-[1-9][0-9]{0,5})$`).exec(path);
  if (run?.[1] && run[2])
    return { page: 'direction', direction: run[1], run: run[2] };
  const turn = new RegExp(`^/d/(${id})/turn/([^/]{1,400})$`).exec(path);
  if (turn?.[1] && turn[2]) {
    const decoded = decode(turn[2]);
    return decoded && turnIdPattern.test(decoded)
      ? { page: 'turn', direction: turn[1], turn: decoded }
      : { page: 'unknown' };
  }
  const runPage = /^\/run\/(r-[1-9][0-9]{0,5})$/.exec(path);
  if (runPage?.[1]) return { page: 'run', id: runPage[1] };
  const agent = /^\/agent\/(a-[1-9][0-9]{0,3})$/.exec(path);
  if (agent?.[1]) return { page: 'agent', id: agent[1] };
  const agentTurn = /^\/agent\/(a-[1-9][0-9]{0,3})\/turn\/([^/]{1,400})$/.exec(
    path,
  );
  if (agentTurn?.[1] && agentTurn[2]) {
    const decoded = decode(agentTurn[2]);
    return decoded && turnIdPattern.test(decoded)
      ? { page: 'agent-turn', agent: agentTurn[1], turn: decoded }
      : { page: 'unknown' };
  }
  const diff = new RegExp(
    `^/d/(${id})/diff(?:/(p-[1-9][0-9]{0,5}\\.[0-9]))?$`,
  ).exec(path);
  if (diff?.[1])
    return diff[2]
      ? { page: 'diff', direction: diff[1], proof: diff[2] }
      : { page: 'diff', direction: diff[1] };
  if (path === '/answer') return { page: 'answer' };
  if (path === '/ask') return { page: 'ask' };
  if (path === '/settings') return { page: 'settings' };
  if (path === '/history') return { page: 'history' };
  const historyRun = /^\/history\/(current|\d{8}T\d{9}Z-[a-f0-9]{6})$/.exec(
    path,
  );
  if (historyRun?.[1]) return { page: 'history-run', id: historyRun[1] };
  if (path === '/start-over') return { page: 'start-over' };
  if (path === '/new') return { page: 'new' };
  if (path === '/project/ask') return { page: 'ask', scope: 'project' };
  const setup =
    /^(\/project)?\/setup(?:\/(agents|about|skills|money|done))?$/.exec(path);
  if (setup)
    return {
      page: 'setup',
      step: (setup[2] as SetupPage | undefined) ?? null,
      ...(setup[1] ? { scope: 'project' as const } : {}),
    };
  return { page: 'unknown' };
}

export const href = {
  lab: '#/',
  direction: (id: string): string => `#/d/${id}`,
  turn: (direction: string, turn: string): string =>
    `#/d/${direction}/turn/${encodeURIComponent(turn)}`,
  call: (id: string): string => `#/call/${id}`,
  answer: '#/answer',
  bring: (direction: string): string => `#/d/${direction}/bring`,
  board: (post: string): string => `#/board/${post}`,
  post: (id: string): string => `#/post/${id}`,
  /** A figure that a post cites, such as p-12.0. */
  figure: (proof: string): string => `#/figure/${proof}`,
  run: (direction: string, run: string): string =>
    `#/d/${direction}/run/${run}`,
  /** A run's own page. */
  runPage: (id: string): string => `#/run/${id}`,
  agent: (id: string): string => `#/agent/${id}`,
  agentTurn: (agent: string, turn: string): string =>
    `#/agent/${agent}/turn/${encodeURIComponent(turn)}`,
  /** What a direction changed, or with `proof` the diff that a post cites. */
  diff: (direction: string, proof?: string): string =>
    `#/d/${direction}/diff${proof ? `/${proof}` : ''}`,
  /** A page of the first run. `scope` `project`: an isolated project's own. */
  setup: (step?: SetupPage, scope?: 'project'): string =>
    `#${scope ? '/project' : ''}/setup${step ? `/${step}` : ''}`,
  ask: '#/ask',
  /** The Ask page of an isolated project. */
  projectAsk: '#/project/ask',
  new: '#/new',
  settings: '#/settings',
  history: '#/history',
  historyRun: (id: string): string => `#/history/${id}`,
  startOver: '#/start-over',
} as const;

/**
 * Go to `route` in place of this page in the history, as a redirect does:
 * Back skips the page that was left.
 */
export function replaceRoute(route: string): void {
  history.replaceState(
    null,
    '',
    `${location.pathname}${location.search}${route}`,
  );
  dispatchEvent(new HashChangeEvent('hashchange'));
}

/**
 * A plain click with the main button and no key held. Any other click on a
 * link does what the browser does with it, such as open it in a new tab.
 */
export function plainClick(event: {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
