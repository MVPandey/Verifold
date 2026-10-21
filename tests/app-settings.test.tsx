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
  Work,
} from '../src/protocol/api.ts';
import {
  agentActions,
  computeActions,
  labActions,
} from '../src/app/actions.ts';
import { Screen } from '../src/app/App.tsx';
import { events, notesFor, freshMemory } from '../src/app/notify.ts';
import {
  allowedNow,
  changesOf,
  podAsker,
  podsLine,
  settingsText,
  shownGpus,
  waitReason,
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
    settingsVersion: 'v1',
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
    works: [],
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
  dismiss: ok,
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
  // Fields that the person does not edit show the newest saved values.
  const newer = render(
    snapshot(
      compute({
        settings: { ...compute().settings, limitUsd: 40 },
        settingsVersion: 'v2',
        agentsAtOnce: 5,
      }),
    ),
    '#/settings',
  );
  assert.match(newer, /value="40"/);
  assert.match(newer, /value="5"/);
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

await test('a paused lab keeps its paused bar beside a waiting pod, and the request says that the pod bills anyway', () => {
  const paused: Lab = {
    ...lab(),
    paused: { at: ago(30), reason: 'person' },
  };
  const page = text(render({ ...snapshot(compute()), lab: paused }, '#/'));
  for (const line of [
    'claude-2 asks for a pod with one H100 SXM, up to $16.03',
    'The lab is paused, but a pod that you approve starts now, and RunPod bills it.',
    'Paused. Agents start no new turns until you resume.',
  ])
    assert.ok(page.includes(line), `missing: ${line}\n${page}`);
  assert.ok(!text(render(snapshot(compute()), '#/')).includes('is paused'));
});

await test('a project without a lab shows the header, its pod requests, and its pods line beside the start of a lab, and notifies its pod requests', () => {
  const html = render(snapshot(compute(), false), '#/');
  assert.match(
    html,
    /<a class="header__link" href="#\/settings">Settings<\/a>/,
  );
  const page = text(html);
  for (const line of [
    'cot-faithfulness has no lab yet',
    // The start of a lab: the question box and the hours.
    'Your question',
    'Time budget, in hours',
    'Start the lab',
    'You asked for a pod with one RTX A5000, up to $0.55',
    'The agent of d-2 asks for a pod with one H100 SXM, up to $16.03',
    'lease-2: Verifold copied the results of r-4 before it stopped the pod.',
  ])
    assert.ok(page.includes(line), `missing: ${line}\n${page}`);
  assert.match(page, /1 pod running · \$0\.42 so far · ends \d\d:\d\d/);
  // With no pod, the panel is empty, and the page hides it.
  assert.match(
    render(snapshot(compute({ pods: [] }), false), '#/'),
    /<section class="pods-panel" aria-label="Pods"><\/section>/,
  );
  // The first pods only prime the notes. A new request then notifies once.
  assert.deepEqual(notesFor(freshMemory, null, 'p', true, true), {
    notes: [],
    memory: freshMemory,
  });
  const first = notesFor(
    freshMemory,
    null,
    'p',
    true,
    true,
    compute({ pods: [] }),
  );
  assert.deepEqual(first.notes, []);
  const next = notesFor(first.memory, null, 'p', true, true, compute());
  assert.deepEqual(
    next.notes.map((note) => note.body),
    [
      'You asked for a pod with one RTX A5000, up to $0.55.',
      'The agent of d-2 asks for a pod with one H100 SXM, up to $16.03.',
    ],
  );
  assert.deepEqual(
    notesFor(next.memory, null, 'p', true, true, compute()).notes,
    [],
  );
});

await test('pod actions in the background show while they run, and a failure stays until the person dismisses it', () => {
  const running: Work = {
    action: 'compute-lease-approve',
    label: 'Starting the pod: lease-1',
    at: ago(1),
    error: null,
    lease: 'lease-1',
  };
  const failed: Work = {
    action: 'compute-lease-end',
    label: 'Ending the pod: lease-2',
    at: ago(2),
    error: 'RunPod did not answer.',
    lease: 'lease-2',
  };
  const works = compute({ works: [running, failed] });
  for (const [shown, hash] of [
    [snapshot(works), '#/'],
    [snapshot(works), '#/settings'],
    [snapshot(works, false), '#/'],
  ] as const) {
    const page = text(render(shown, hash));
    assert.ok(page.includes('Starting the pod: lease-1…'), page);
    assert.ok(
      page.includes('Ending the pod: lease-2 failed: RunPod did not answer.'),
      page,
    );
  }
  const block = (shown: ProjectCompute): string =>
    /<div class="status status--muted pod-notice" role="status">(.*?)<\/div>/.exec(
      render(snapshot(shown), '#/'),
    )?.[1] ?? '';
  assert.match(block(works), />Dismiss<\/button>/);
  // While an action only runs, there is nothing to dismiss.
  assert.doesNotMatch(block(compute({ works: [running] })), /Dismiss/);
  assert.equal(block(compute()), '');
});

await test('the settings form sends only what the person changed, and turns pods off with an empty limit', () => {
  // Fields that the person did not touch stay out, so a change made elsewhere stays.
  assert.deepEqual(changesOf({}, null), {});
  assert.deepEqual(changesOf({ idleMinutes: ' 20 ', limitUsd: ' ' }, null), {
    idleMinutes: 20,
    limitUsd: null,
  });
  assert.deepEqual(changesOf({ images: ' a \n\n b ' }, null), {
    images: ['a', 'b'],
  });
  assert.deepEqual(
    changesOf({ maxRunningPods: '2', askBeforePod: false }, ['NVIDIA H200']),
    { maxRunningPods: 2, askBeforePod: false, gpuTypes: ['NVIDIA H200'] },
  );
  assert.equal(
    changesOf({ idleMinutes: 'soon' }, null),
    'Give each limit as a number.',
  );
  assert.equal(
    changesOf({ limitUsd: 'lots' }, null),
    'Give the spend limit as a number, or leave it empty to turn pods off.',
  );
  // The GPUs: the saved ones, with the person's ticks and unticks on top.
  assert.deepEqual(
    allowedNow(
      ['NVIDIA H200', 'NVIDIA RTX A5000'],
      ['NVIDIA L4'],
      ['NVIDIA H200'],
    ),
    ['NVIDIA RTX A5000', 'NVIDIA L4'],
  );
  assert.deepEqual(allowedNow(['NVIDIA L4'], ['NVIDIA L4'], []), ['NVIDIA L4']);
  const off = { ...compute().settings, limitUsd: null };
  assert.equal(settingsText(off).limitUsd, '');
  assert.equal(settingsText(off).images, off.images.join('\n'));
});

await test('the GPU rows: common and saved types first, then every other type, each group the dearest first', () => {
  const types = compute().gpus?.types ?? [];
  const l4 = {
    id: 'NVIDIA L4',
    name: 'L4',
    memoryGb: 24,
    usdPerHour: 0.39,
    stock: 'high' as const,
    common: false,
  };
  // The saved settings decide: a row that the person unticks stays.
  assert.deepEqual(
    shownGpus(types, ['NVIDIA RTX A5000'], false).map((gpu) => gpu.id),
    ['NVIDIA H200', 'NVIDIA H100 80GB HBM3', 'NVIDIA RTX A5000'],
  );
  // With every GPU, an allowed type that costs less still comes before a dearer one that is not allowed.
  const listed = [...types.slice(0, 2), l4, ...types.slice(2)];
  assert.deepEqual(
    shownGpus(listed, ['NVIDIA RTX A4000'], true).map((gpu) => gpu.id),
    [
      'NVIDIA H200',
      'NVIDIA H100 80GB HBM3',
      'NVIDIA RTX A4000',
      'NVIDIA L4',
      'NVIDIA RTX A5000',
    ],
  );
});

await test('a waiting pod says why it waits: a secret, the person approves each pod, or the limits', () => {
  const ask = compute().settings;
  const auto = { ...ask, askBeforePod: false };
  assert.equal(waitReason(pod(), ask), 'you approve each pod');
  assert.equal(waitReason(pod(), auto), 'it does not fit your limits now');
  const secret = pod({ secrets: ['HF_TOKEN'], missingSecrets: ['HF_TOKEN'] });
  assert.equal(waitReason(secret, auto), 'it waits for a secret');
  assert.equal(waitReason(secret, ask), 'it waits for a secret');
  assert.equal(
    waitReason(pod({ missingSecrets: ['HF_TOKEN', 'WANDB_API_KEY'] }), auto),
    'it waits for secrets',
  );
  const page = text(
    render(snapshot(compute({ settings: auto, pods: [secret] })), '#/'),
  );
  assert.ok(page.includes('it waits for a secret'), page);
  assert.ok(!page.includes('it does not fit your limits now'), page);
});

await test('a pod that lacks several secrets shows one command for each', () => {
  const two = pod({
    secrets: ['HF_TOKEN', 'WANDB_API_KEY'],
    missingSecrets: ['HF_TOKEN', 'WANDB_API_KEY'],
  });
  const page = text(render(snapshot(compute({ pods: [two] })), '#/'));
  assert.ok(
    page.includes(
      'The pod needs the secrets HF_TOKEN and WANDB_API_KEY, which this computer does not store yet. Store each one in a terminal with verifold runpod secret set HF_TOKEN and verifold runpod secret set WANDB_API_KEY , then approve the pod.',
    ),
    page,
  );
});

await test('pod words: who asked, the waiting pods, and the running line', () => {
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
  await live.save({ limitUsd: 30, askBeforePod: false }, 'v1', 'a');
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
  await live.dismiss(
    [
      {
        action: 'compute-lease-end',
        label: 'Ending the pod: lease-2',
        at: ago(2),
        error: 'RunPod did not answer.',
        lease: 'lease-2',
      },
    ],
    'd',
  );
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
      '/api/v1/actions/compute-dismiss',
    ],
  );
  // Only the changed fields go, with the version that the person edited.
  assert.deepEqual(sent[0]?.body, {
    limitUsd: 30,
    askBeforePod: false,
    base: 'v1',
    key: 'a',
  });
  assert.deepEqual(sent[2]?.body, { agents: 5, key: 'c' });
  assert.deepEqual(sent[3]?.body, { lease: 'lease-1', key: 'approve' });
  // Dismiss names the failures that the page showed, by action and start.
  assert.deepEqual(sent[9]?.body, {
    works: [{ action: 'compute-lease-end', at: ago(2) }],
    key: 'd',
  });
  assert.deepEqual(await computeActions(null).agents(2, 'k'), {
    refused: 'This tab has no access key.',
  });
});
