import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Agent,
  Direction,
  Lab,
  PodLease,
  ProjectCompute,
  Snapshot,
} from '../src/protocol/api.ts';
import {
  agentActions,
  computeActions,
  labActions,
} from '../src/app/actions.ts';
import { Screen } from '../src/app/App.tsx';
import { events, notesFor, freshMemory } from '../src/app/notify.ts';
import {
  podAsker,
  podsLine,
  settingsOf,
  settingsText,
  shownGpus,
  waitingPods,
} from '../src/app/pods.ts';
import { href, parseRoute } from '../src/app/route.ts';
import type { ComputeActions } from '../src/app/screens/SettingsPage.tsx';

/** A fixed "now": Tuesday 2026-10-20, 22:00 UTC. */
const now = Date.UTC(2026, 9, 20, 22, 0);
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();
const later = (minutes: number): string =>
  new Date(now + minutes * 60_000).toISOString();

function agent(id: string, handle: string, direction: string): Agent {
  return {
    id,
    handle,
    harness: 'claude',
    model: null,
    direction,
    check: null,
    status: 'idle',
    until: null,
    live: { state: 'idle', text: 'Between turns', since: ago(5) },
    turns: { turns: [], more: false },
    spendUsd: null,
  };
}

function direction(id: string, title: string, agentId: string): Direction {
  return {
    id,
    title,
    bar: null,
    runs: 3,
    noise: null,
    buildsOn: [],
    state: 'open',
    verdict: 'open',
    disputed: false,
    evidence: null,
    agent: agentId,
    openedBy: 'a-0',
    openedAt: ago(120),
    stoppedAt: null,
    head: 'a3f9c2e',
  };
}

function lab(): Lab {
  return {
    question: 'Can cheap training make a CoT faithful?',
    startedAt: ago(600),
    agentsHere: true,
    paused: null,
    budget: null,
    money: { plansUsd: 3.1, gpuUsd: 4.2, gpuLimitUsd: 25 },
    needsYou: [],
    answered: [],
    directions: [
      direction('d-2', 'The CoT matches what probes read inside', 'a-2'),
    ],
    agents: [agent('a-2', 'claude-2', 'd-2')],
    plan: null,
    board: { posts: [], more: false },
    disputes: [],
    runs: [],
    checks: [],
    signoff: null,
    works: [],
    away: null,
    omitted: {},
  };
}

function pod(fields: Partial<PodLease> = {}): PodLease {
  return {
    id: 'lease-1',
    state: 'requested',
    gpu: 'NVIDIA H100 80GB HBM3',
    asker: 'agent',
    directions: ['d-2'],
    reason: { text: 'Rerun the probes on 3 seeds.', trimmed: false },
    rateUsd: 4.0,
    hours: 4,
    maxUsd: 16.03,
    spentUsd: 0,
    requestedAt: ago(12),
    endsAt: null,
    idleMinutes: null,
    ended: null,
    notice: null,
    noticeAt: null,
    secrets: [],
    missingSecrets: [],
    ...fields,
  };
}

function compute(fields: Partial<ProjectCompute> = {}): ProjectCompute {
  return {
    keyStored: { last4: 'WXYZ', problem: null },
    settings: {
      limitUsd: 25,
      maxUsdPerHour: 4,
      maxHoursPerLease: 4,
      idleMinutes: 15,
      maxRunningPods: 1,
      gpuTypes: ['NVIDIA H100 80GB HBM3', 'NVIDIA RTX A5000'],
      images: ['runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404'],
      diskGb: 50,
      askBeforePod: true,
    },
    agentsAtOnce: 3,
    budget: { spentUsd: 4.2, heldUsd: 3.1, leftUsd: 17.7, rateUsd: 0.28 },
    month: { spentUsd: 37.2, limitUsd: 100, leftUsd: 59.7 },
    pods: [
      pod(),
      pod({
        id: 'lease-3',
        state: 'requested',
        asker: 'person',
        directions: [],
        gpu: 'NVIDIA RTX A5000',
        secrets: ['HF_TOKEN'],
        missingSecrets: ['HF_TOKEN'],
        maxUsd: 0.55,
        requestedAt: ago(30),
      }),
      pod({
        id: 'lease-2',
        state: 'ready',
        gpu: 'NVIDIA RTX A5000',
        rateUsd: 0.28,
        spentUsd: 0.42,
        endsAt: later(70),
        idleMinutes: 9,
        notice: 'Verifold copied the results of r-4 before it stopped the pod.',
        noticeAt: ago(3),
      }),
    ],
    earlier: [
      pod({
        id: 'lease-0',
        state: 'ended',
        spentUsd: 1.12,
        ended: { at: ago(400), reason: 'its hours ended.' },
      }),
    ],
    earlierCount: 4,
    gpus: {
      at: ago(5),
      types: [
        {
          id: 'NVIDIA H200',
          name: 'H200',
          memoryGb: 141,
          usdPerHour: 4.49,
          stock: 'low',
          common: true,
        },
        {
          id: 'NVIDIA H100 80GB HBM3',
          name: 'H100 SXM',
          memoryGb: 80,
          usdPerHour: 3.99,
          stock: 'high',
          common: true,
        },
        {
          id: 'NVIDIA RTX A5000',
          name: 'RTX A5000',
          memoryGb: 24,
          usdPerHour: 0.27,
          stock: 'medium',
          common: false,
        },
        {
          id: 'NVIDIA RTX A4000',
          name: 'RTX A4000',
          memoryGb: 16,
          usdPerHour: 0.25,
          stock: 'high',
          common: false,
        },
      ],
    },
    problem: null,
    ...fields,
  };
}

function snapshot(shown: ProjectCompute | undefined, withLab = true): Snapshot {
  return {
    protocolVersion: 1,
    epoch: 'e1',
    rev: 3,
    at: ago(0),
    project: 'cot-faithfulness',
    lab: withLab ? lab() : null,
    ...(shown ? { compute: shown } : {}),
    trimmed: false,
  };
}

const ok = (): Promise<{ ok: true }> => Promise.resolve({ ok: true });
const signedIn: ComputeActions = {
  save: ok,
  prices: ok,
  agents: ok,
  pod: ok,
};

function render(state: Snapshot, hash: string): string {
  return renderToStaticMarkup(
    <Screen
      state={{ snapshot: state, connection: 'live', retrying: false }}
      route={parseRoute(hash)}
      now={now}
      actions={labActions(null)}
      agentActions={agentActions(null)}
      compute={signedIn}
    />,
  );
}

/** Visible text, with tags removed and entities decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

await test('the settings page has its own address, and the header links to it', () => {
  assert.deepEqual(parseRoute('#/settings'), { page: 'settings' });
  assert.equal(href.settings, '#/settings');
  assert.deepEqual(parseRoute('#/settings/x'), { page: 'unknown' });
  assert.match(
    render(snapshot(compute()), '#/'),
    /<a class="header__link" href="#\/settings">Settings<\/a>/,
  );
});

await test('the settings page shows the pods, the limits, the GPUs, and Agents at once', () => {
  const page = text(render(snapshot(compute()), '#/settings'));
  for (const line of [
    'Settings',
    'These settings belong to this project. A change applies at once, with no undo. New projects start from the defaults in your profile .',
    'Spent $4.20. Held for running pods $3.10. Left $17.70 of $25. Pods cost $0.28 an hour now.',
    'This month, all projects: $37.20 of $100.',
    // The waiting pods, the oldest first.
    'You asked for a pod with one RTX A5000, up to $0.55',
    'claude-2 asks for a pod with one H100 SXM, up to $16.03',
    'claude-2 says: Rerun the probes on 3 seeds.',
    'The pod needs the secret HF_TOKEN, which this computer does not store yet. Store it in a terminal with verifold runpod secret set HF_TOKEN , then approve the pod.',
    'Approve, up to $16.03',
    // The pod that runs, with its idle time, its rate, and its end.
    'Running Idle 9 min',
    '$0.42 $0.28 an hour',
    'Stop End',
    'lease-2: Verifold copied the results of r-4 before it stopped the pod.',
    'Earlier pods (4)',
    'Its hours ended.',
    'This project spends at most $',
    'Ask me before each pod starts',
    // Common and allowed GPUs show; the others wait behind a button.
    'H200 141 GB $4.49 Above your cap Low',
    'H100 SXM 80 GB $3.99 High',
    'RTX A5000 24 GB $0.27 Medium',
    'Show every GPU that RunPod lists (4)',
    'Save the GPU settings',
    'Agents that work at the same time, 1 to 8',
  ])
    assert.ok(page.includes(line), `missing: ${line}\n${page}`);
  assert.ok(!page.includes('RTX A4000'));
  const html = render(snapshot(compute()), '#/settings');
  // The pod that lacks a secret cannot be approved yet.
  assert.match(
    html,
    /<button type="button" class="button button--dark" disabled="">Approve, up to \$0\.55<\/button>/,
  );
  assert.match(html, /value="25"/);
  assert.match(html, /value="3"/);
});

await test('the settings page works without a lab, says when pods are off, and asks for a key first', () => {
  const off = compute({
    keyStored: null,
    gpus: null,
    pods: [],
    earlier: [],
    earlierCount: 0,
    month: null,
    budget: { spentUsd: 0, heldUsd: 0, leftUsd: null, rateUsd: 0 },
    settings: { ...compute().settings, limitUsd: null, askBeforePod: false },
  });
  const page = text(render(snapshot(off, false), '#/settings'));
  for (const line of [
    'Pods are off: this project has no spend limit.',
    'No pod runs. An agent asks for a pod when its direction needs a GPU. A pod that fits your limits starts at once. Other requests wait for you.',
    'Store a RunPod key under GPU money in your profile to see the GPUs and their prices. Allowed now: NVIDIA H100 80GB HBM3, NVIDIA RTX A5000.',
  ])
    assert.ok(page.includes(line), `missing: ${line}\n${page}`);
  // A process that does not manage the project's pods says so.
  assert.match(
    text(render(snapshot(undefined, false), '#/settings')),
    /This Verifold does not manage the pods of this project\./,
  );
});

await test('a waiting pod shows in Needs you on the lab home, and a running pod as one line', () => {
  const html = render(snapshot(compute()), '#/');
  const page = text(html);
  assert.ok(
    page.includes(
      'Needs you claude-2 asks for a pod with one H100 SXM, up to $16.03',
    ),
  );
  assert.ok(page.includes('Approve, up to $16.03 Deny'));
  assert.ok(!page.includes('Nothing needs you.'));
  assert.match(
    html,
    /<a class="status status--plan pods-line" href="#\/settings">/,
  );
  assert.match(page, /1 pod running · \$0\.42 so far · ends \d\d:\d\d/);
  assert.ok(page.includes('Dismiss'));
  // With no pod and no call, nothing needs the person.
  const quiet = text(
    render(snapshot(compute({ pods: [], earlier: [], earlierCount: 0 })), '#/'),
  );
  assert.ok(quiet.includes('Nothing needs you.'));
  assert.ok(!quiet.includes('pod running'));
});

await test('the settings form keeps what the person typed, and turns pods off with an empty limit', () => {
  const settings = compute().settings;
  const typed = settingsText(settings);
  assert.deepEqual(settingsOf(typed, settings.gpuTypes), settings);
  assert.equal(
    (settingsOf({ ...typed, limitUsd: ' ' }, []) as { limitUsd: unknown })
      .limitUsd,
    null,
  );
  assert.equal(
    settingsOf({ ...typed, idleMinutes: 'soon' }, []),
    'Give each limit as a number. Leave the spend limit empty to turn pods off.',
  );
  assert.deepEqual(
    (settingsOf({ ...typed, images: ' a \n\n b ' }, []) as { images: unknown })
      .images,
    ['a', 'b'],
  );
});

await test('pod words: who asked, the waiting pods, the running line, and the GPUs to show', () => {
  const shown = compute();
  assert.deepEqual(
    waitingPods(shown).map((entry) => entry.id),
    ['lease-3', 'lease-1'],
  );
  assert.equal(podAsker(pod({ asker: 'person' }), lab()), 'You');
  assert.equal(podAsker(pod(), lab()), 'claude-2');
  assert.equal(
    podAsker(pod({ directions: ['d-9'] }), lab()),
    'The agent of d-9',
  );
  assert.equal(
    podAsker(pod({ asker: 'coordinator' }), null),
    'The coordinator',
  );
  assert.equal(podsLine(compute({ pods: [] })), null);
  const two = compute({
    pods: [
      pod({ id: 'lease-4', state: 'ready', spentUsd: 1 }),
      pod({ id: 'lease-5', state: 'starting', spentUsd: 0.5 }),
    ],
  });
  assert.equal(podsLine(two), '2 pods running · $1.50 so far · $0.28 an hour');
  const types = shown.gpus?.types ?? [];
  assert.deepEqual(
    shownGpus(types, ['NVIDIA RTX A5000'], false).map((gpu) => gpu.id),
    ['NVIDIA H200', 'NVIDIA H100 80GB HBM3', 'NVIDIA RTX A5000'],
  );
  assert.equal(shownGpus(types, [], true).length, 4);
});

await test('a pod that waits for the person notifies once, like a call', () => {
  const shown = compute();
  const notes = events(lab(), 'cot-faithfulness', shown).filter((note) =>
    note.key.startsWith('pod:'),
  );
  assert.deepEqual(notes, [
    {
      key: 'pod:lease-3',
      title: 'cot-faithfulness needs you',
      body: 'You asked for a pod with one RTX A5000, up to $0.55.',
      route: '#/',
    },
    {
      key: 'pod:lease-1',
      title: 'cot-faithfulness needs you',
      body: 'claude-2 asks for a pod with one H100 SXM, up to $16.03.',
      route: '#/',
    },
  ]);
  // The first snapshot only primes; a new pod request then notifies once.
  const first = notesFor(
    freshMemory,
    lab(),
    'p',
    true,
    true,
    compute({ pods: [] }),
  );
  assert.deepEqual(first.notes, []);
  const next = notesFor(first.memory, lab(), 'p', true, true, shown);
  assert.deepEqual(
    next.notes.map((note) => note.key),
    ['pod:lease-3', 'pod:lease-1'],
  );
  assert.deepEqual(
    notesFor(next.memory, lab(), 'p', true, true, shown).notes,
    [],
  );
});

await test("the compute actions send the desk's action names with the intent key, and refuse without a token", async (t) => {
  const sent: { url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: input instanceof Request ? input.url : input.toString(),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  };
  const live = computeActions('token');
  await live.save(compute().settings, 'a');
  await live.prices('b');
  await live.agents(5, 'c');
  for (const action of [
    'approve',
    'deny',
    'stop',
    'start',
    'end',
    'dismiss',
  ] as const)
    await live.pod(action, 'lease-1', action);
  assert.deepEqual(
    sent.map((entry) => entry.url),
    [
      '/api/v1/actions/compute-settings',
      '/api/v1/actions/compute-gpus',
      '/api/v1/actions/compute-agents',
      '/api/v1/actions/compute-lease-approve',
      '/api/v1/actions/compute-lease-deny',
      '/api/v1/actions/compute-lease-stop',
      '/api/v1/actions/compute-lease-start',
      '/api/v1/actions/compute-lease-end',
      '/api/v1/actions/compute-lease-dismiss',
    ],
  );
  assert.deepEqual(sent[2]?.body, { agents: 5, key: 'c' });
  assert.deepEqual(sent[3]?.body, { lease: 'lease-1', key: 'approve' });
  assert.deepEqual(await computeActions(null).agents(2, 'k'), {
    refused: 'This tab has no access key.',
  });
});
