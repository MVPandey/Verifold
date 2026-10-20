import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fakePod, type FakePod } from './fake-pod.ts';

/** A fake pod, with the folder of task-1 whose writable path is results/. */
async function setup(t: test.TestContext): Promise<FakePod & { task: string }> {
  const made: { task?: string } = {};
  const fake = await fakePod(t, {
    taskFolder: (id) =>
      Promise.resolve(
        id === 'task-1' && made.task
          ? { id, folder: made.task, writable: ['results'] }
          : null,
      ),
  });
  const task = join(fake.dir, 'task-folder');
  await mkdir(join(task, 'results'), { recursive: true });
  made.task = task;
  return { ...fake, task };
}

const place = (
  task: string,
): { id: string; folder: string; writable: string[] } => ({
  id: 'task-1',
  folder: task,
  writable: ['results'],
});

await test('a pod gets its own SSH key, and Verifold pins the host key from the pod log', async (t) => {
  const { compute, dir, home, pods, logged, fingerprint } = await setup(t);
  // Verifold computes fingerprints as ssh-keygen does.
  const hostKey = process.env.FAKE_HOST_KEY ?? '';
  assert.equal(
    `SHA256:${createHash('sha256')
      .update(Buffer.from(hostKey.split(' ')[1] ?? '', 'base64'))
      .digest('base64')
      .replace(/=+$/, '')}`,
    fingerprint,
  );
  const id = (
    await compute.leases.request({
      by: 'coordinator',
      gpu: 'NVIDIA RTX A5000',
      hours: 2,
      tasks: ['task-1'],
      reason: 'Train on a GPU.',
    })
  ).id;
  await compute.leases.approve(id);
  // The pod got the lease's public key; the private key stays outside the project.
  const sent = pods.get('pod1')?.env.PUBLIC_KEY ?? '';
  assert.match(sent, /^ssh-ed25519 \S+ verifold-lease-1$/);
  const [folder] = execFileSync(
    'find',
    [join(home, '.verifold', 'credentials', 'ssh'), '-name', 'lease-1'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  assert.ok(folder);
  assert.equal((await stat(folder)).mode & 0o777, 0o600);
  // A host key that differs from the log is refused: the lease stays starting.
  logged.fingerprint = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  await compute.leases.poll();
  assert.equal(compute.leases.get(id).state, 'starting');
  // SSH that does not answer keeps it starting too.
  logged.fingerprint = fingerprint;
  process.env.FAKE_SSH_DOWN = '1';
  await compute.leases.poll();
  assert.equal(compute.leases.get(id).state, 'starting');
  delete process.env.FAKE_SSH_DOWN;
  await compute.leases.poll();
  const lease = compute.leases.get(id);
  assert.equal(lease.state, 'ready');
  assert.match(
    lease.history.at(-1)?.text ?? '',
    /host key matches the key in its log\. Its watchdog stops it at the end of the lease/,
  );
  // The watchdog stops the pod with the pod's own key at the deadline, or 15 minutes after the last heartbeat.
  const watchdog = await readFile(join(dir, 'watchdog.txt'), 'utf8');
  assert.match(
    watchdog,
    new RegExp(
      `echo ${Math.floor(Date.parse(lease.deadline ?? '') / 1000)} > /root/verifold/\\.watchdog/deadline`,
    ),
  );
  assert.match(watchdog, /\$\(\(now - beat\)\) -ge 900/);
  assert.match(watchdog, /runpodctl stop pod "\$RUNPOD_POD_ID"/);
});

await test('a task runs commands and jobs on its pod and copies files both ways, inside its writable paths', async (t) => {
  const { compute, pod, task, home } = await setup(t);
  const tools = compute.podTools();
  assert.equal(tools.on(), true);
  assert.deepEqual(
    tools.specs.map((spec) => spec.name),
    ['verifold_pod_run', 'verifold_pod_job', 'verifold_pod_copy'],
  );
  // Without a ready pod, a call says what to do.
  await assert.rejects(
    tools.call(place(task), 'verifold_pod_run', { command: 'echo hi' }),
    /no ready pod\. Ask the coordinator/,
  );
  const id = (
    await compute.leases.request({
      by: 'coordinator',
      gpu: 'NVIDIA RTX A5000',
      hours: 2,
      tasks: ['task-1'],
      reason: 'Train on a GPU.',
    })
  ).id;
  await compute.leases.approve(id);
  await assert.rejects(
    tools.call(place(task), 'verifold_pod_run', { command: 'echo hi' }),
    /not ready yet/,
  );
  await compute.leases.poll();
  assert.equal(compute.leases.get(id).state, 'ready');

  const run = await tools.call(place(task), 'verifold_pod_run', {
    command: 'echo hello from the pod\npwd\nexit 4',
  });
  assert.match(
    run,
    /^Exit code 4\.\nhello from the pod\n.*\/pod\/verifold\/task-1\n$/,
  );
  const started = await tools.call(place(task), 'verifold_pod_run', {
    command: 'echo working; exit 3',
    background: true,
  });
  const job = /Started (job-[0-9a-f]{8})/.exec(started)?.[1] ?? '';
  assert.ok(job);
  let state = '';
  for (let tries = 0; tries < 100 && !state.startsWith('Done'); tries++) {
    state = await tools.call(place(task), 'verifold_pod_job', { job });
    if (!state.startsWith('Done')) await delay(50);
  }
  assert.equal(state, 'Done, exit code 3.\nworking\n');
  await assert.rejects(
    tools.call(place(task), 'verifold_pod_job', { job: '../x' }),
    /Name a job/,
  );

  // Copies: to the pod, and back only into writable paths, as regular files.
  await writeFile(join(task, 'results', 'in.txt'), 'input\n');
  assert.match(
    await tools.call(place(task), 'verifold_pod_copy', {
      direction: 'to-pod',
      paths: ['results/in.txt'],
    }),
    /Copied 1 files/,
  );
  assert.equal(
    await readFile(
      join(pod, 'verifold', 'task-1', 'results', 'in.txt'),
      'utf8',
    ),
    'input\n',
  );
  await writeFile(
    join(pod, 'verifold', 'task-1', 'results', 'out.txt'),
    'output\n',
  );
  await symlink(
    '/etc/hosts',
    join(pod, 'verifold', 'task-1', 'results', 'link'),
  );
  await mkdir(join(pod, 'verifold', 'task-1', 'data'));
  await writeFile(join(pod, 'verifold', 'task-1', 'data', 'big.bin'), 'x');
  await assert.rejects(
    tools.call(place(task), 'verifold_pod_copy', {
      direction: 'from-pod',
      paths: ['data'],
    }),
    /outside the writable paths/,
  );
  await assert.rejects(
    tools.call(place(task), 'verifold_pod_copy', {
      direction: 'from-pod',
      paths: ['../etc'],
    }),
    /inside the project/,
  );
  const back = await tools.call(place(task), 'verifold_pod_copy', {
    direction: 'from-pod',
    paths: ['results'],
  });
  assert.match(
    back,
    /Copied 2 files from the pod: results\/(in|out)\.txt, results\/(in|out)\.txt\. Refused, because they are not regular files inside the writable paths: results\/link\./,
  );
  assert.equal(
    await readFile(join(task, 'results', 'out.txt'), 'utf8'),
    'output\n',
  );
  await assert.rejects(lstat(join(task, 'results', 'link')), /ENOENT/);

  // Before a stop, the results come back; at the end of the lease, the keys go.
  await writeFile(
    join(pod, 'verifold', 'task-1', 'results', 'out.txt'),
    'final\n',
  );
  await compute.leases.stop(id, 'person', 'done for now');
  assert.equal(
    await readFile(join(task, 'results', 'out.txt'), 'utf8'),
    'final\n',
  );
  await compute.leases.end(id, 'person', 'done');
  const left = execFileSync(
    'find',
    [join(home, '.verifold', 'credentials', 'ssh'), '-type', 'f'],
    { encoding: 'utf8' },
  ).trim();
  assert.equal(left, '');
});

await test('a pod gets its secrets as environment variables, and pod output hides their values', async (t) => {
  const { compute, task, dir, pods } = await setup(t);
  const value = 'hf_SECRETVALUE0123456789';
  await compute.setSecret('HF_TOKEN', value, true);
  const id = (
    await compute.leases.request({
      by: 'coordinator',
      gpu: 'NVIDIA RTX A5000',
      hours: 1,
      tasks: ['task-1'],
      reason: 'Load gated weights.',
      secrets: ['HF_TOKEN'],
    })
  ).id;
  await compute.leases.approve(id);
  await compute.leases.poll();
  const env = [...pods.values()].at(-1)?.env ?? {};
  assert.equal(env.HF_TOKEN, value);
  assert.match(env.PUBLIC_KEY ?? '', /^ssh-ed25519 /);
  const tools = compute.podTools();
  // A command that prints the value gets its name in brackets instead.
  const run = await tools.call(place(task), 'verifold_pod_run', {
    command: `echo token=${value}`,
  });
  assert.match(run, /token=\[HF_TOKEN\]/);
  assert.doesNotMatch(run, /SECRETVALUE/);
  // So does an error that quotes a path.
  const copy = await tools
    .call(place(task), 'verifold_pod_copy', {
      direction: 'to-pod',
      paths: [`../${value}`],
    })
    .catch((error: unknown) => (error instanceof Error ? error.message : ''));
  assert.match(copy, /\[HF_TOKEN\]/);
  assert.doesNotMatch(copy, /SECRETVALUE/);
  // The lease record names the secret and holds no value.
  assert.deepEqual(compute.leases.get(id).secrets, ['HF_TOKEN']);
  assert.doesNotMatch(
    await readFile(
      join(dir, 'project', '.verifold', 'compute', 'leases', `${id}.json`),
      'utf8',
    ),
    /SECRETVALUE/,
  );
});
