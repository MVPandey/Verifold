import test from 'node:test';
import assert from 'node:assert/strict';
import { personNotice, type Lease } from '../src/core/leases.ts';
import type { PodRuns } from '../src/core/runs.ts';
import type { Call, LabCompute } from '../src/core/lab/schema.ts';
import { asksForPod } from '../src/core/lab/words.ts';
import { planned, type Built } from './lab-step-fixture.ts';
import { until } from './wait.ts';

const at = '2026-11-02T20:09:56.000Z';
const noStock =
  'RunPod answered with 400. RunPod says: There are no longer any instances available with the requested specifications. Please refresh and try again.';

function leaseOf(more: Partial<Lease>): Lease {
  return {
    schemaVersion: 1,
    id: 'lease-1',
    state: 'failed',
    requestedBy: 'agent',
    reason: 'c-1: Seeds need a GPU.',
    tasks: [],
    directions: ['d-1'],
    gpu: 'NVIDIA A100-SXM4-80GB',
    image: 'runpod/pytorch',
    diskGb: 50,
    hours: 2,
    rate: 1.79,
    requestedAt: at,
    decidedAt: at,
    podName: 'vf-lease-1',
    podId: null,
    deadline: null,
    ssh: null,
    intervals: [],
    billedUsd: null,
    billedAt: null,
    seen: null,
    activeAt: null,
    notice: `RunPod did not create the pod for lease-1. ${noStock}`,
    history: [],
    end: { at, by: 'failure', reason: noStock },
    ...more,
  };
}

/** Pods that RunPod has none of: each start of a call fails, and a request inside the limits starts. */
function noPods(): {
  readonly compute: LabCompute;
  readonly requests: unknown[];
  readonly leases: Lease[];
} {
  const requests: unknown[] = [];
  const leases: Lease[] = [];
  const compute: LabCompute = {
    describe: () => Promise.resolve('{}'),
    requestPod: (input) => {
      requests.push(input);
      return Promise.resolve('Started lease-9.');
    },
    podCost: () => Promise.resolve(3.59),
    podsAtOnce: () => 1,
    setPodsAtOnce: () => Promise.resolve({ before: 1, changed: true }),
    startPod: (input) => {
      const lease = leaseOf({
        id: `lease-${leases.length + 1}`,
        gpu: String(input.gpu),
        directions: input.directions,
      });
      leases.push(lease);
      return Promise.resolve(lease);
    },
    podsOn: () => true,
    keySaved: () => true,
    leases: {
      list: () => leases,
      get: (id) =>
        leases.find((lease) => lease.id === id) ?? assert.fail('No lease.'),
      end: (id) =>
        Promise.resolve(
          leases.find((lease) => lease.id === id) ?? assert.fail('No lease.'),
        ),
    },
    podRuns: () => ({}) as PodRuns,
  };
  return { compute, requests, leases };
}

const request = (gpuType: string): Record<string, unknown> => ({
  gpuType,
  hours: 2,
  why: 'Seeds need a GPU.',
});

const podAsk = {
  kind: 'cost',
  question: 'An RTX 4090 or an L40S for the fade test?',
  options: [
    {
      label: 'RTX 4090, 2 hours',
      effect: { pod: { gpuType: 'NVIDIA GeForce RTX 4090', hours: 2 } },
    },
    { label: 'Not now' },
  ],
  pick: 0,
  why: 'The A100 is out of stock.',
};

function callOf(built: Built, id: string): Call {
  return (
    built.view().state.calls.find((call) => call.id === id) ??
    assert.fail(`No call ${id}.`)
  );
}

await test('one answer allows GPU pods for the lab, also when RunPod has none of the first GPU, and closes the calls that only ask for a pod', async (t) => {
  const pods = noPods();
  const built = await planned(t, { compute: pods.compute });
  const idIn = (text: string, pattern: RegExp): string =>
    pattern.exec(text)?.[1] ?? assert.fail(text);
  // A call that offers a pod opens while pods wait for the person.
  const other = idIn(
    (await built.call(2, 'verifold_ask_person', podAsk)).text,
    /in (c-\d+)\./,
  );
  // A pod request asks to allow pods, and joins no other pod call.
  const first = await built.call(
    0,
    'verifold_request_pod',
    request('NVIDIA A100-SXM4-80GB'),
  );
  const id = idIn(first.text, /in (c-\d+) to allow GPU pods/);
  assert.notEqual(id, other);
  assert.equal(
    callOf(built, id).question,
    'Allow GPU pods in this lab? After this, agents pick GPUs inside your limits.',
  );
  // A second agent's request joins it: the person answers once for the lab.
  const second = await built.call(
    1,
    'verifold_request_pod',
    request('NVIDIA L40S'),
  );
  assert.match(
    second.text,
    new RegExp(
      `asked the person already in ${id} to allow GPU pods, and your request joined it\\.`,
    ),
  );
  // A call that asks for more than a pod keeps what is left for the person.
  const mixed = idIn(
    (
      await built.call(1, 'verifold_ask_person', {
        ...podAsk,
        question: 'An RTX 4090, or 2 pods at once?',
        options: [
          podAsk.options[0],
          { label: '2 pods at once', effect: { podsAtOnce: 2 } },
        ],
      })
    ).text,
    /in (c-\d+)\./,
  );
  // RunPod has no A100: the answer still allows pods, and nothing is billed.
  await built.lab.answerCall(id, 0);
  const answered = callOf(built, id);
  assert.equal(answered.state, 'answered');
  assert.deepEqual(answered.applied, { type: 'pod', lease: 'lease-1' });
  assert.equal(
    answered.note,
    'RunPod had no NVIDIA A100-SXM4-80GB free, so no pod started and nothing was billed. GPU pods are allowed in this lab now: each agent picks its GPU, and a request inside the limits starts with no call.',
  );
  assert.equal(pods.leases.length, 1);
  const withdrawn = callOf(built, other);
  assert.equal(withdrawn.state, 'withdrawn');
  assert.match(
    withdrawn.note ?? '',
    new RegExp(`^The person allowed GPU pods in ${id}\\.`),
  );
  assert.equal(callOf(built, mixed).state, 'open');
  // Now each agent picks its GPU with no call.
  assert.equal(
    (await built.call(1, 'verifold_request_pod', request('NVIDIA L40S'))).text,
    'Started lease-9.',
  );
  assert.equal(pods.requests.length, 1);
  assert.match(
    (await built.call(2, 'verifold_ask_person', podAsk)).text,
    /^GPU pods are allowed in this lab\./,
  );
  assert.deepEqual(
    built
      .view()
      .state.calls.filter((call) => call.state === 'open')
      .map((call) => call.id),
    [mixed],
  );
});

await test('words on a pod call reach its agent and keep the call open, so the agent does not ask again', async (t) => {
  const pods = noPods();
  const built = await planned(t, { compute: pods.compute });
  const reply = await built.call(
    0,
    'verifold_request_pod',
    request('NVIDIA A100-SXM4-80GB'),
  );
  const id = /in (c-\d+) to allow GPU pods/.exec(reply.text)?.[1];
  assert.ok(id, reply.text);
  const words = 'Get whichever GPU makes sense for the task and is available.';
  await built.lab.answerCallInWords(id, words);
  const call = callOf(built, id);
  assert.equal(call.state, 'open');
  assert.equal(call.words, words);
  assert.equal(pods.leases.length, 0);
  assert.ok(
    built
      .view()
      .posts.some(
        (post) =>
          post.author === 'person' &&
          post.text === words &&
          post.replyTo === call.post,
      ),
  );
  const agent = built.started[0];
  assert.ok(agent);
  built.endTurn(agent);
  await until(() =>
    built.sent.some(
      (entry) => entry.id === agent.id && entry.text.includes(id),
    ),
  );
  const heard = built.sent.find((entry) => entry.id === agent.id)?.text ?? '';
  assert.match(
    heard,
    new RegExp(
      `The person wrote on ${id}: "Get whichever GPU makes sense for the task and is available\\.". Words start no pod, so ${id} still waits for their choice\\. Do not ask again`,
    ),
  );
  // The option still answers it.
  await built.lab.answerCall(id, 0);
  assert.equal(callOf(built, id).state, 'answered');
});

await test('a lab pod that RunPod had no GPU for shows the person no notice; other notices stay', () => {
  assert.equal(personNotice(leaseOf({})), null);
  // A key or a balance that RunPod refuses: the person must act, so the notice stays.
  const refused = 'RunPod answered with 401. RunPod says: Unauthorized.';
  assert.equal(
    personNotice(
      leaseOf({
        end: { at, by: 'failure', reason: refused },
        notice: `RunPod did not create the pod for lease-1. ${refused}`,
      }),
    ),
    `RunPod did not create the pod for lease-1. ${refused}`,
  );
  // A task lease of the older team: no agent hears it, so the person does.
  assert.match(
    personNotice(leaseOf({ directions: [] })) ?? '',
    /^RunPod did not create the pod for lease-1\./,
  );
  // A pod that RunPod created and then lost.
  assert.equal(
    personNotice(
      leaseOf({ podId: 'pod-1', notice: 'RunPod no longer has the pod.' }),
    ),
    'RunPod no longer has the pod.',
  );
  assert.equal(
    personNotice(leaseOf({ state: 'ended', notice: 'The pod stopped.' })),
    'The pod stopped.',
  );
});

await test('a call asks for a pod when one of its options has a pod effect', () => {
  const option = {
    label: 'Rent it',
    usd: 1,
    minutes: null,
    effect: null,
  } as const;
  assert.equal(asksForPod({ options: [option] }), false);
  assert.equal(
    asksForPod({
      options: [
        option,
        {
          ...option,
          effect: {
            type: 'pod',
            gpuType: 'NVIDIA L40S',
            hours: 1,
            secrets: [],
          },
        },
      ],
    }),
    true,
  );
});
