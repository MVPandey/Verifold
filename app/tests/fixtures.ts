import type {
  AgentView,
  HarnessOption,
  LabView,
  Offer,
  Post,
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

export function agentView(id: string, changes: Partial<AgentView> = {}): AgentView {
  return {
    agent: {
      id,
      name: `Agent ${id.replace('agent-', '')}`,
      harness: id === 'agent-2' ? 'codex' : 'claude-code',
      model: { family: 'anthropic', name: null, effort: null },
      role: '',
      brief: '',
      mode: null,
      recruited_by: null,
      checks: null,
    },
    activity: { state: 'idle', detail: '', at: null },
    turns: 0,
    posts: 0,
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    cost_usd: null,
    ...changes,
  };
}

export function result(id: string, changes: Partial<Post> = {}): Post {
  return {
    id,
    thread: 't-1',
    author: 'agent-1',
    text: 'sorted() is 12x faster',
    body: '',
    reply_to: null,
    mentions: [],
    evidence: [],
    kind: 'result',
    ...changes,
  } as Post;
}

export function ask(id: string, author: string, choices: readonly string[] = []): Post {
  return {
    id,
    thread: 't-2',
    author,
    text: `Permission needed: run ${id}`,
    body: '',
    reply_to: null,
    mentions: ['person'],
    evidence: [],
    kind: 'ask',
    choices,
  };
}

export function postView(post: Post, seq = 1, standing: PostView['standing'] = 'open'): PostView {
  return { seq, at: '2026-11-06T14:04:00Z', post, standing };
}

export function summary(changes: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    thread: { id: 't-1', title: 'A · sorted() against merge sort', opened_by: 'agent-1' },
    watching: false,
    posts: 3,
    last_at: '2026-11-06T14:09:00Z',
    latest: {
      seq: 7,
      at: '2026-11-06T14:09:00Z',
      author: 'agent-2',
      kind: 'check',
      text: 'Reran it.',
    },
    disputed: 0,
    checked: 0,
    not_checked: 0,
    open_asks: 0,
    ...changes,
  };
}

export function labView(changes: Partial<LabView> = {}): LabView {
  return {
    question: 'Is sorted() faster?',
    opened_at: '2026-11-06T14:00:00Z',
    seq: 9,
    agents: [],
    threads: 1,
    posts: 3,
    needs_you: 0,
    ends_at: null,
    out_of_time: false,
    settings: { version: 1, jobs: { at_time_limit: 'pause', at_exit: 'stop' } },
    ...changes,
  };
}
