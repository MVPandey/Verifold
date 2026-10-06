import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Compute } from '../src/cli/compute.ts';
import { KeyStore } from '../src/cli/credentials.ts';

const key = 'rpa_TESTKEY0123456789abcdefWXYZ';

/**
 * A fake `ssh`: it checks the key and the pinned host key like the real one,
 * then runs the remote command with bash in a local folder that stands for the
 * pod. `timeout` is left out, because macOS has none.
 */
const fakeSsh = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = args.indexOf('--');
const option = (name) => args.find((arg, index) => args[index - 1] === '-o' && arg.startsWith(name + '='))?.split('=')[1];
const identity = args[args.indexOf('-i') + 1];
const port = args[args.indexOf('-p') + 1];
const host = args[at - 1].split('@')[1];
fs.appendFileSync(process.env.FAKE_DIR + '/ssh.log', JSON.stringify(args) + '\\n');
const known = fs.existsSync(option('UserKnownHostsFile')) ? fs.readFileSync(option('UserKnownHostsFile'), 'utf8') : '';
if (!fs.existsSync(identity) || !known.startsWith('[' + host + ']:' + port + ' ' + process.env.FAKE_HOST_KEY)) {
  process.stderr.write('Host key verification failed.\\n');
  process.exit(255);
}
// The watchdog loop runs for the life of a pod, so the fake records its script instead of starting it.
if (args.slice(at + 1).join(' ') === 'bash -s') {
  fs.writeFileSync(process.env.FAKE_DIR + '/watchdog.txt', fs.readFileSync(0, 'utf8'));
  fs.mkdirSync(process.env.FAKE_POD + '/verifold/.watchdog', { recursive: true });
  process.stdout.write('watching\\n');
  process.exit(0);
}
const remote = args.slice(at + 1).join(' ').replaceAll('/root/verifold', process.env.FAKE_POD + '/verifold').replace(/timeout \\d+ /, '');
const result = spawnSync('bash', ['-c', remote], { stdio: ['inherit', 'inherit', 'inherit'] });
process.exit(result.status ?? 1);
`;
const fakeKeyscan = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.FAKE_SSH_DOWN === '1') process.exit(1);
process.stdout.write('[' + args.at(-1) + ']:' + args[args.indexOf('-p') + 1] + ' ' + process.env.FAKE_HOST_KEY + '\\n');
`;

interface Pod {
  id: string;
  status: string;
  env: Record<string, string>;
}

async function setup(t: test.TestContext): Promise<{
  compute: Compute;
  pod: string;
  task: string;
  dir: string;
  home: string;
  pods: Map<string, Pod>;
  logged: { fingerprint: string };
  fingerprint: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'verifold-pods-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const root = join(dir, 'project');
  const pod = join(dir, 'pod');
  const task = join(dir, 'task-folder');
  await mkdir(root);
  await mkdir(pod);
  await mkdir(join(task, 'results'), { recursive: true });
  // The pod's host key, made by the real ssh-keygen.
  execFileSync('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-f',
    join(dir, 'host'),
  ]);
  const hostKey = (await readFile(join(dir, 'host.pub'), 'utf8'))
    .split(' ')
    .slice(0, 2)
    .join(' ');
  const fingerprint =
    execFileSync('ssh-keygen', ['-lf', join(dir, 'host.pub')], {
      encoding: 'utf8',
    }).split(' ')[1] ?? '';
  for (const [name, text] of [
    ['ssh', fakeSsh],
    ['ssh-keyscan', fakeKeyscan],
  ] as const) {
    await writeFile(join(dir, name), text);
    await chmod(join(dir, name), 0o755);
  }
  const saved = { ...process.env };
  t.after(() => {
    for (const name of [
      'FAKE_DIR',
      'FAKE_POD',
      'FAKE_HOST_KEY',
      'FAKE_SSH_DOWN',
    ])
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
  });
  process.env.FAKE_DIR = dir;
  process.env.FAKE_POD = pod;
  process.env.FAKE_HOST_KEY = hostKey;
  const pods = new Map<string, Pod>();
  const logged = { fingerprint };
  const server = createServer((request: IncomingMessage, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const json = (status: number, value?: unknown): void => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(value === undefined ? '' : JSON.stringify(value));
      };
      const url = new URL(request.url ?? '/', 'http://x');
      const match = /^\/v2\/pods\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
      const found = match ? pods.get(match[1] ?? '') : undefined;
      const view = (entry: Pod): unknown => ({
        id: entry.id,
        name: 'vf',
        status: entry.status,
        cost: 0.27,
        env: entry.env,
        ssh: {
          direct:
            entry.status === 'RUNNING'
              ? {
                  host: '127.0.0.1',
                  port: 2200,
                  username: 'root',
                  command: 'ssh',
                }
              : null,
        },
        runtime: { gpus: [{ util: 0 }] },
      });
      if (url.pathname.startsWith('/v2/catalog/gpus'))
        json(200, {
          gpus: [
            {
              id: 'NVIDIA RTX A5000',
              name: 'RTX A5000',
              memory: 24,
              secure: true,
              price: { secure: 0.27 },
              availability: 'HIGH',
            },
          ],
        });
      else if (request.method === 'GET' && url.pathname === '/v2/pods')
        json(200, {
          pods: [...pods.values()].map(view),
          pagination: { nextCursor: null },
        });
      else if (request.method === 'POST' && url.pathname === '/v2/pods') {
        const input = JSON.parse(body) as { env?: Record<string, string> };
        const created = {
          id: `pod${pods.size + 1}`,
          status: 'RUNNING',
          env: input.env ?? {},
        };
        pods.set(created.id, created);
        json(201, view(created));
      } else if (found && match?.[2] === '/logs') {
        // The pod's start script prints its host key fingerprints.
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(
          `data: ${JSON.stringify({ source: 'container', line: 'Setting up SSH...' })}\n\ndata: ${JSON.stringify({ source: 'container', line: `256 ${logged.fingerprint} root@pod (ED25519)` })}\n\n`,
        );
      } else if (found && match?.[2] === '/action') {
        found.status =
          (JSON.parse(body) as { action: string }).action === 'stop'
            ? 'EXITED'
            : 'RUNNING';
        json(200, view(found));
      } else if (found && request.method === 'DELETE') {
        pods.delete(found.id);
        json(204);
      } else if (found) json(200, view(found));
      else if (url.pathname === '/v2/billing/pods') json(200, { records: [] });
      else json(404, { title: 'Not Found', status: 404, detail: 'none' });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  const compute = new Compute(root, {
    store: new KeyStore({
      home,
      platform: 'linux',
      secretTool: join(dir, 'none'),
    }),
    url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
    programs: { ssh: join(dir, 'ssh'), keyscan: join(dir, 'ssh-keyscan') },
    taskFolder: (id) =>
      Promise.resolve(
        id === 'task-1' ? { id, folder: task, writable: ['results'] } : null,
      ),
  });
  await compute.load();
  await compute.setKey(key, true);
  await compute.saveSettings({
    limitUsd: '10',
    maxUsdPerHour: '1',
    maxHoursPerLease: '4',
    idleMinutes: '15',
    maxRunningPods: '1',
    diskGb: '50',
    images: 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404',
    gpuTypes: ['NVIDIA RTX A5000'],
  });
  return { compute, pod, task, dir, home, pods, logged, fingerprint };
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
