import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type test from 'node:test';
import { Compute } from '../src/core/compute.ts';
import { KeyStore } from '../src/core/credentials.ts';
import type { TaskPlace } from '../src/core/compute.ts';
import type { Lease } from '../src/core/leases.ts';

/**
 * A fake RunPod for tests: a local HTTP server for the RunPod API, a fake
 * `ssh` that runs remote commands with bash in a local folder that stands for
 * the pod, and a fake `ssh-keyscan`. No call leaves this computer.
 */

export const key = 'rpa_TESTKEY0123456789abcdefWXYZ';

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

export interface Pod {
  id: string;
  status: string;
  env: Record<string, string>;
}

export interface FakePod {
  readonly compute: Compute;
  /** The project folder. */
  readonly root: string;
  /** The local folder that stands for the pod's root home. */
  readonly pod: string;
  readonly dir: string;
  readonly home: string;
  readonly pods: Map<string, Pod>;
  readonly logged: { fingerprint: string };
  readonly fingerprint: string;
}

/** A project with a stored RunPod key, limits that allow one RTX A5000, and a fake RunPod. */
export async function fakePod(
  t: test.TestContext,
  options: {
    readonly taskFolder?: (task: string) => Promise<TaskPlace | null>;
    readonly runsStop?: (lease: string) => Promise<void>;
    readonly onChange?: (lease: Lease, line: string, wake: boolean) => void;
    /** RunPod got a stop, a start, or a delete (`terminate`) of a pod, and did not act yet. */
    readonly onAction?: (action: string) => void;
  } = {},
): Promise<FakePod> {
  const dir = await mkdtemp(join(tmpdir(), 'verifold-pods-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const root = join(dir, 'project');
  const pod = join(dir, 'pod');
  await mkdir(root);
  await mkdir(pod);
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
      'FAKE_ACTION_FAILS',
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
        const action = (JSON.parse(body) as { action: string }).action;
        options.onAction?.(action);
        found.status = action === 'stop' ? 'EXITED' : 'RUNNING';
        // RunPod acted, but its answer did not come back.
        if (process.env.FAKE_ACTION_FAILS === '1')
          json(500, { detail: 'lost' });
        else json(200, view(found));
      } else if (found && request.method === 'DELETE') {
        options.onAction?.('terminate');
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
    ...(options.taskFolder ? { taskFolder: options.taskFolder } : {}),
    ...(options.runsStop ? { runsStop: options.runsStop } : {}),
    ...(options.onChange ? { onChange: options.onChange } : {}),
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
  return { compute, root, pod, dir, home, pods, logged, fingerprint };
}
