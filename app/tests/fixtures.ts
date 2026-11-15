import type {
  AgentView,
  HarnessOption,
  LabView,
  Offer,
  PermissionShown,
  Post,
  QuestionShown,
  SetupDefaults,
  PostView,
  ThreadSummary,
} from '../src/api/types.ts';

export const OFFER: Offer = {
  models: [
    {
      value: 'default',
      name: 'Default (recommended)',
      efforts: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      value: 'opus',
      name: 'Opus',
      efforts: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
    { value: 'haiku', name: 'Haiku', efforts: [] },
    { value: 'sonnet', name: 'Sonnet', efforts: null },
  ],
  efforts: [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ],
  modes: [
    { value: 'default', name: 'Manual' },
    { value: 'plan', name: 'Plan' },
    { value: 'auto', name: 'Auto' },
  ],
  model: 'opus',
  effort: 'high',
  mode: 'default',
};

/** Verifold's defaults for new labs: one agent of each harness, auto mode, and no time limit. */
export const DEFAULTS: SetupDefaults = { agents: null, auto_mode: true, minutes: null };

export const HARNESSES: readonly HarnessOption[] = [
  {
    name: 'claude-code',
    title: 'Claude Code',
    family: 'anthropic',
    available: true,
    probing: false,
    offer: OFFER,
  },
  {
    name: 'codex',
    title: 'Codex',
    family: 'openai',
    available: false,
    probing: false,
    offer: null,
  },
];

/** An agent that chose no name, no picture, and no about line: its seat's label is its name. */
export function agentView(id: string, changes: Partial<AgentView> = {}): AgentView {
  const name = `Agent ${id.replace('agent-', '')}`;
  return {
    agent: {
      id,
      name,
      harness: id === 'agent-2' ? 'codex' : 'claude-code',
      model: { family: 'anthropic', name: null, effort: null },
      role: '',
      brief: '',
      given_role: '',
      mode: null,
      recruited_by: null,
      checks: null,
    },
    seat: name,
    chosen_name: '',
    about: '',
    about_by: null,
    in_turn: false,
    picture: null,
    given_role: '',
    given_by: null,
    reviewer: false,
    flag: '',
    edits: [],
    need: 'idle',
    outcomes: { built_on: [], held: [], refuted: [], open_asks: [] },
    turns_started: 0,
    role: '',
    on_call: false,
    coordinator: false,
    status: '',
    thread: null,
    activity: { state: 'idle', detail: '', at: null },
    left: null,
    stopped: false,
    turns: 0,
    turn_ended_at: null,
    alarm: null,
    posts: 0,
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    cost_usd: null,
    error: null,
    ...changes,
  };
}

export function result(id: string, changes: Partial<Post> = {}): Post {
  return {
    id,
    thread: 't-1',
    author: 'agent-1',
    helper: '',
    text: 'sorted() is 12x faster',
    body: '',
    reply_to: null,
    mentions: [],
    builds_on: [],
    evidence: [],
    kind: 'result',
    ...changes,
  } as Post;
}

export function ask(
  id: string,
  author: string,
  choices: readonly string[] = [],
  request: 'permission' | 'question' | null = 'permission',
  shown: PermissionShown | QuestionShown | null = null,
): Post {
  return {
    id,
    thread: 't-2',
    author,
    helper: '',
    text: `Permission needed: run ${id}`,
    body: '',
    reply_to: null,
    mentions: ['person'],
    builds_on: [],
    evidence: [],
    kind: 'ask',
    choices,
    request,
    shown,
  };
}

export function postView(
  post: Post,
  seq = 1,
  standing: PostView['standing'] = 'open',
  builtOnBy: readonly string[] = [],
): PostView {
  return { seq, at: '2026-11-06T14:04:00Z', post, by: null, standing, built_on_by: builtOnBy };
}

export function summary(changes: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    thread: { id: 't-1', title: 'A · sorted() against merge sort', opened_by: 'agent-1' },
    watching: false,
    members: [],
    posts: 3,
    last_at: '2026-11-06T14:09:00Z',
    latest: {
      id: 'p-3',
      thread: 't-1',
      author: 'agent-2',
      kind: 'check',
      text: 'Reran it.',
      reply_to: 'p-1',
      seq: 7,
      at: '2026-11-06T14:09:00Z',
      by: null,
    },
    disputed: 0,
    checked: 0,
    not_checked: 0,
    open_asks: 0,
    open_calls: 0,
    team: [],
    builds_on_threads: [],
    built_on_by_threads: [],
    crossed: 0,
    ...changes,
  };
}

export function labView(changes: Partial<LabView> = {}): LabView {
  return {
    question: 'Is sorted() faster?',
    coordinator_open: true,
    versions: [],
    opened_at: '2026-11-06T14:00:00Z',
    seq: 9,
    agents: [],
    threads: 1,
    posts: 3,
    needs_you: 0,
    waits: [],
    thread_needs: {},
    reruns_wanted: [],
    reviewer_seats: 0,
    reviewer_seats_set: null,
    ends_at: null,
    out_of_time: false,
    state: 'open',
    close: null,
    close_agreed: 0,
    close_among: 0,
    settings: {
      version: 1,
      jobs: { at_time_limit: 'pause', at_exit: 'stop' },
      permissions: { while_you_decide: 'auto' },
      reviewers: { seats: null },
    },
    deliverables: [],
    removed_deliverables: [],
    deliverables_told_at: null,
    ...changes,
  };
}
