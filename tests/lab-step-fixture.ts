import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab } from '../src/core/lab.ts';
import type {
  LabCompute,
  LabSessions,
  LabView,
} from '../src/core/lab/schema.ts';
import type { AgentTools } from '../src/core/session-hosts.ts';
import type { SessionRecord, SessionView } from '../src/core/session.ts';
import { changeWorkspace } from '../src/core/storage.ts';
import { gitEnvironment } from '../src/core/workspaces.ts';
import { ApiReader } from '../src/server/api.ts';
import { until } from './wait.ts';

/** A fixture's Git call. Inside a Git hook, GIT_* variables point at the Verifold repository, so `gitEnvironment` drops them. */
function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args],
    { cwd, stdio: 'ignore', env: gitEnvironment() },
  );
}

export interface Started {
  readonly id: string;
  readonly agent: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly tools: AgentTools;
}

/** Fake worker slots: a start records its input, and no harness runs. */
function fakeSessions(limit: number): {
  readonly sessions: LabSessions;
  readonly started: Started[];
  readonly sent: { readonly id: string; readonly text: string }[];
  readonly idle: Set<string>;
  readonly live: Set<string>;
} {
  const started: Started[] = [];
  const sent: { readonly id: string; readonly text: string }[] = [];
  const live = new Set<string>();
  const idle = new Set<string>();
  const sessions: LabSessions = {
    get full(): boolean {
      return live.size >= limit;
    },
    limit,
    view: (id) =>
      live.has(id)
        ? ({
            live: true,
            record: {
              id,
              status: idle.has(id) ? 'idle' : 'running',
              launches: [{ id: `run-${id}` }],
            },
          } as unknown as SessionView)
        : null,
    idle: (id) => idle.has(id),
    startAgent: (input) => {
      const id = `20261101T000000000Z-${String(started.length + 1).padStart(8, '0')}`;
      started.push({
        id,
        agent: input.agent,
        prompt: input.prompt,
        cwd: input.cwd,
        tools: input.tools,
      });
      live.add(id);
      return Promise.resolve(id);
    },
    resumeAgent: (id) => {
      live.add(id);
      return Promise.resolve();
    },
    takeAgentTerminal: () => Promise.resolve(),
    park: (id) => {
      live.delete(id);
      idle.delete(id);
      return Promise.resolve(true);
    },
    continueTask: (id, text) => {
      sent.push({ id, text });
      idle.delete(id);
    },
    steer: () => false,
    endTask: (id) => {
      live.delete(id);
      idle.delete(id);
    },
  };
  return { sessions, started, sent, idle, live };
}

async function project(t: TestContext): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'verifold-step-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = join(base, 'project');
  await mkdir(root);
  git(root, 'init', '--quiet');
  await writeFile(join(root, 'README.md'), '# Project\n');
  await changeWorkspace(root, () => ({
    schemaVersion: 1,
    visibility: 'private',
    profile: {
      name: 'R',
      interests: ['Graphs'],
      scholar: '',
      github: '',
      session: '',
    },
    host: 'claude',
    candidates: [],
    selectedId: null,
  }));
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'start');
  return root;
}

export interface Built extends ReturnType<typeof fakeSessions> {
  readonly lab: Lab;
  readonly root: string;
  readonly call: (
    index: number,
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ readonly ok: boolean; readonly text: string }>;
  readonly view: () => LabView;
  readonly reader: () => ApiReader;
  /** A turn of the session ends. */
  readonly endTurn: (started: Started) => void;
}

let calls = 0;

/** A lab with threads and three directions, each with its agent started. */
export async function planned(
  t: TestContext,
  more: {
    readonly limit?: number;
    readonly objectionMs?: number;
    readonly share?: string;
    readonly compute?: LabCompute;
  } = {},
): Promise<Built> {
  const root = await project(t);
  const fake = fakeSessions(more.limit ?? 8);
  let seed = 0;
  const lab = new Lab(root, {
    sessions: fake.sessions,
    reserved: fake.sessions,
    sandbox: (spec) => ({ file: '/bin/sh', args: ['-c', spec.command] }),
    harnesses: () => Promise.resolve(['claude', 'codex']),
    ...(more.compute ? { compute: more.compute } : {}),
    random: () => {
      seed = (seed + 0.618_033_988_75) % 1;
      return seed;
    },
    timing: {
      tickMs: 5,
      debounceMs: 5,
      continueMs: 60_000,
      objectionMs: more.objectionMs ?? 3_600_000,
    },
  });
  t.after(() => lab.close());
  // A draw here runs at once: a real Coordinator keeps an update scheduled for 3 minutes.
  (
    lab as unknown as { coordinator: { idle(): Promise<boolean> } }
  ).coordinator.idle = () => Promise.resolve(true);
  const view = (): LabView => {
    const shown = lab.view();
    assert.ok(shown);
    return shown;
  };
  const call: Built['call'] = (index, name, input) => {
    const agent = fake.started[index];
    assert.ok(agent);
    calls += 1;
    return agent.tools.call(name, input, `step-${calls}`);
  };
  await lab.start(
    'Do months sit on a circle?',
    more.share ? { share: more.share } : {},
  );
  await until(() => fake.started.length > 0);
  const plan = await call(0, 'verifold_plan', {
    reading: 'How I read it.',
    cost: 'Nothing yet.',
    directions: ['Alpha', 'Beta', 'Gamma'].map((title) => ({
      title,
      job: title,
      team: 'One',
      bar: 'It beats the control.',
      runs: 3,
      noise: '±0.02',
      buildsOn: [],
      harness: 'claude',
    })),
  });
  assert.equal(plan.ok, true, plan.text);
  await until(() => fake.started.length >= 3);
  return {
    ...fake,
    lab,
    root,
    view,
    call,
    reader: () =>
      new ApiReader(() => ({
        root,
        lab,
        compute: undefined,
        session: () => null,
        away: () => Promise.resolve(null),
        works: [],
      })),
    endTurn: (started) => {
      fake.idle.add(started.id);
      lab.turnEnded(
        {
          id: started.id,
          agent: started.agent,
          status: 'idle',
          launches: [],
        } as unknown as SessionRecord,
        'completed',
      );
    },
  };
}

/** The post ID in a tool's reply. */
export const posted = (text: string): string =>
  /Posted (p-\d+)/.exec(text)?.[1] ?? assert.fail(text);

/** A thread with a first post of an agent. Returns the post and its thread. */
export async function opened(
  built: Built,
  index: number,
  kind = 'ask',
  more: Record<string, unknown> = {},
): Promise<{ readonly post: string; readonly thread: string }> {
  const reply = await built.call(index, 'verifold_post', {
    kind,
    title: 'Does the control beat chance on seed 2?',
    why: 'The bar rests on it.',
    text: 'Which seed leaks?',
    ...more,
  });
  assert.equal(reply.ok, true, reply.text);
  const post = built
    .view()
    .posts.find((entry) => entry.id === posted(reply.text));
  assert.ok(post?.thread);
  return { post: post.id, thread: post.thread };
}
