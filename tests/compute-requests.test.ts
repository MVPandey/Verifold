import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { SessionActionError } from '../src/core/session.ts';
import { ComputeRequests } from '../src/server/compute-actions.ts';

/** The run of an action that ends when the test says so. */
function later(): {
  readonly run: () => Promise<number>;
  readonly runs: () => number;
  readonly finish: (code: number) => void;
  readonly refuse: (message: string) => void;
} {
  let runs = 0;
  let finish: (code: number) => void = () => {};
  let refuse: (message: string) => void = () => {};
  return {
    run: () => {
      runs++;
      return new Promise<number>((resolve, reject) => {
        finish = resolve;
        refuse = (message) => reject(new SessionActionError(message));
      });
    },
    runs: () => runs,
    finish: (code) => finish(code),
    refuse: (message) => refuse(message),
  };
}

const keyA = 'a'.repeat(32);
const keyB = 'b'.repeat(32);

// The 202 timer does not hold the process open, as a desk's server does. This does, until the last test.
const open = setInterval(() => {}, 60_000);

await test('a slow pod action answers 202 and goes on, and a failure after that waits for Dismiss', async () => {
  const requests = new ComputeRequests(20);
  const approve = later();
  const body = { action: 'compute-lease-approve', lease: 'lease-1', key: keyA };
  assert.equal(await requests.act(body, approve.run), 202);
  assert.deepEqual(
    requests.works.map((work) => [work.label, work.error, work.lease]),
    [['Starting the pod: lease-1', null, 'lease-1']],
  );
  // A retry after a lost answer gets the same answer, and starts no second pod.
  assert.equal(await requests.act(body, approve.run), 202);
  assert.equal(approve.runs(), 1);
  approve.refuse('RunPod has no capacity for this GPU.');
  await tick();
  assert.deepEqual(
    requests.works.map((work) => [work.label, work.error]),
    [['Starting the pod: lease-1', 'RunPod has no capacity for this GPU.']],
  );
  // A new try of the same action on the same pod replaces the failure.
  const again = later();
  assert.equal(
    await requests.act(
      { action: 'compute-lease-approve', lease: 'lease-1', key: keyB },
      again.run,
    ),
    202,
  );
  assert.deepEqual(
    requests.works.map((work) => work.error),
    [null],
  );
  again.refuse('RunPod has no capacity for this GPU.');
  // A slow action that ends well leaves no line.
  const end = later();
  assert.equal(
    await requests.act(
      { action: 'compute-lease-end', lease: 'lease-2' },
      end.run,
    ),
    202,
  );
  end.finish(200);
  await tick();
  assert.deepEqual(
    requests.works.map((work) => [work.label, work.error]),
    [['Starting the pod: lease-1', 'RunPod has no capacity for this GPU.']],
  );
  // Dismiss removes the failures, and runs nothing.
  assert.equal(
    await requests.act({ action: 'compute-dismiss' }, () =>
      Promise.reject(new Error('Dismiss runs no action.')),
    ),
    200,
  );
  assert.deepEqual(requests.works, []);
});

await test('a slow action that ends in time is the answer, and so is its refusal, with no line after it', async () => {
  const requests = new ComputeRequests(1_000);
  assert.equal(
    await requests.act({ action: 'compute-lease-stop', lease: 'lease-1' }, () =>
      Promise.resolve(200),
    ),
    200,
  );
  await assert.rejects(
    requests.act({ action: 'compute-lease-start', lease: 'lease-1' }, () =>
      Promise.reject(new SessionActionError('1 pod runs already.')),
    ),
    /1 pod runs already\./,
  );
  assert.deepEqual(requests.works, []);
});

await test('the same intent key gets the same answer, a refused intent runs again, and a RunPod key is never an intent key', async () => {
  const requests = new ComputeRequests(20);
  let denies = 0;
  const deny = (): Promise<number> => {
    denies++;
    return denies === 1
      ? Promise.resolve(200)
      : Promise.reject(
          new SessionActionError('lease-1 does not wait for approval.'),
        );
  };
  const body = { action: 'compute-lease-deny', lease: 'lease-1', key: keyA };
  assert.equal(await requests.act(body, deny), 200);
  assert.equal(await requests.act(body, deny), 200);
  assert.equal(denies, 1);
  // A new intent runs.
  await assert.rejects(
    requests.act({ ...body, key: keyB }, deny),
    /does not wait for approval/,
  );
  assert.equal(denies, 2);
  // A refusal keeps no answer: the same request again tries again.
  let tries = 0;
  const agents = (): Promise<number> => {
    tries++;
    return Promise.reject(
      new SessionActionError('Choose a whole number of agents from 1 to 8.'),
    );
  };
  const nine = { action: 'compute-agents', agents: 9, key: 'c'.repeat(32) };
  await assert.rejects(requests.act(nine, agents), /from 1 to 8/);
  await assert.rejects(requests.act(nine, agents), /from 1 to 8/);
  assert.equal(tries, 2);
  // The desk's key action carries a RunPod key in `key`, so each one runs.
  let saves = 0;
  const save = (): Promise<number> => {
    saves++;
    return Promise.resolve(200);
  };
  const stored = { action: 'compute-key-save', key: 'd'.repeat(32) };
  assert.equal(await requests.act(stored, save), 200);
  assert.equal(await requests.act(stored, save), 200);
  assert.equal(saves, 2);
});

clearInterval(open);
