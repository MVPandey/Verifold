import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compute } from '../src/core/compute.ts';
import { parseFrame, renderDesk } from '../src/desk/desk-view.ts';
import { KeyStore } from '../src/core/credentials.ts';
import {
  accrued,
  budget,
  diskRate,
  reserved,
  spent,
  type Lease,
  type MonthHooks,
} from '../src/core/leases.ts';
import { GpuMonth, monthFolder } from '../src/core/gpu-month.ts';
import { prepareAgency, saveAgencyFile } from '../src/core/agency.ts';
import { profileMoneyDefaults } from '../src/core/compute.ts';
import { runCli } from '../src/cli/commands.ts';

const key = 'rpa_TESTKEY0123456789abcdefWXYZ';

interface FakePod {
  id: string;
  name: string;
  status: string;
  cost: number;
  port: number;
  reads: number;
}

/**
 * A fake RunPod API with pods that move from PROVISIONING to STARTING to
 * RUNNING over three reads. `mode` scripts faults: no capacity, or a create
 * whose reply is lost after the pod exists. Pods carry an `env` with a fake
 * token, which must not reach any record.
 */
async function fakeRunPod(t: test.TestContext): Promise<{
  url: string;
  pods: Map<string, FakePod>;
  calls: string[];
  mode: {
    create: 'ok' | 'capacity' | 'lost';
    cost: number;
    billed: number;
    secrets: string[];
  };
  envs: Record<string, string>[];
}> {
  const pods = new Map<string, FakePod>();
  const calls: string[] = [];
  const envs: Record<string, string>[] = [];
  const mode: {
    create: 'ok' | 'capacity' | 'lost';
    cost: number;
    billed: number;
    /** The secret names that a create may carry next to the SSH key. */
    secrets: string[];
  } = {
    create: 'ok',
    cost: 0.27,
    billed: 0,
    secrets: [],
  };
  let next = 1;
  const view = (pod: FakePod): unknown => ({
    id: pod.id,
    name: pod.name,
    status: pod.status,
    cost: pod.status === 'RUNNING' ? pod.cost : 0,
    env: { PUBLIC_KEY: 'x', HF_TOKEN: 'hf_FAKETOKEN123' },
    locked: false,
    ssh: {
      proxy: null,
      direct:
        pod.status === 'RUNNING'
          ? {
              host: '203.0.113.7',
              port: pod.port,
              username: 'root',
              command: 'ssh',
            }
          : null,
    },
    runtime:
      pod.status === 'RUNNING' ? { gpus: [{ util: 0, memoryUtil: 0 }] } : null,
  });
  const server = createServer((request: IncomingMessage, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      calls.push(`${request.method ?? ''} ${request.url ?? ''}`);
      const json = (status: number, value?: unknown): void => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(value === undefined ? '' : JSON.stringify(value));
      };
      if (request.headers.authorization !== `Bearer ${key}`) {
        json(401, { title: 'Unauthorized', status: 401, detail: 'bad key' });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://x');
      const match = /^\/v2\/pods\/([^/]+)(\/action)?$/.exec(url.pathname);
      const pod = match
        ? pods.get(decodeURIComponent(match[1] ?? ''))
        : undefined;
      if (
        request.method === 'GET' &&
        url.pathname.startsWith('/v2/catalog/gpus')
      ) {
        json(200, {
          gpus: [
            {
              id: 'NVIDIA RTX A5000',
              name: 'RTX A5000',
              memory: 24,
              secure: true,
              community: true,
              price: { secure: 0.27, community: 0.16 },
              availability: 'HIGH',
            },
            {
              id: 'NVIDIA GeForce RTX 4090',
              name: 'RTX 4090',
              memory: 24,
              secure: true,
              community: true,
              price: { secure: 0.74, community: 0.34 },
              availability: 'LOW',
            },
            {
              id: 'NVIDIA H100 80GB HBM3',
              name: 'H100',
              memory: 80,
              secure: true,
              community: true,
              price: { secure: 0.4, community: 0.3 },
              availability: 'NONE',
            },
          ],
        });
      } else if (request.method === 'POST' && url.pathname === '/v2/pods') {
        const input = JSON.parse(body) as Record<string, unknown>;
        assert.deepEqual(Object.keys(input).sort(), [
          'cloud',
          'disk',
          'env',
          'gpu',
          'image',
          'name',
          'ports',
        ]);
        // The variables are the lease's own SSH public key and the secrets that it names.
        const env = input.env as Record<string, string>;
        assert.match(
          env.PUBLIC_KEY ?? '',
          /^ssh-ed25519 \S+ verifold-lease-\d+$/,
        );
        assert.deepEqual(
          Object.keys(env)
            .filter((name) => name !== 'PUBLIC_KEY')
            .sort(),
          mode.secrets,
        );
        envs.push(env);
        assert.equal(input.cloud, 'SECURE');
        assert.deepEqual(input.ports, ['22/tcp']);
        if (mode.create === 'capacity') {
          json(400, {
            title: 'Bad Request',
            status: 400,
            detail: 'no capacity for this GPU',
          });
          return;
        }
        const created: FakePod = {
          id: `pod${next}`,
          name: String(input.name),
          status: 'PROVISIONING',
          cost: mode.cost,
          port: 22000 + next,
          reads: 0,
        };
        next++;
        pods.set(created.id, created);
        if (mode.create === 'lost') {
          request.socket.destroy();
          return;
        }
        json(201, view(created));
      } else if (request.method === 'GET' && url.pathname === '/v2/pods') {
        json(200, {
          pods: [...pods.values()].map(view),
          pagination: { nextCursor: null, hasNextPage: false },
        });
      } else if (request.method === 'GET' && pod && !match?.[2]) {
        // Each read moves a starting pod one step on.
        if (pod.status === 'PROVISIONING') pod.status = 'STARTING';
        else if (pod.status === 'STARTING') pod.status = 'RUNNING';
        pod.reads++;
        json(200, view(pod));
      } else if (request.method === 'POST' && pod && match?.[2]) {
        const action = (JSON.parse(body) as { action: string }).action;
        pod.status = action === 'stop' ? 'EXITED' : 'PROVISIONING';
        if (action === 'start') pod.port += 100;
        json(200, view(pod));
      } else if (request.method === 'DELETE' && pod) {
        pods.delete(pod.id);
        json(204);
      } else if (
        request.method === 'GET' &&
        url.pathname === '/v2/billing/pods'
      ) {
        // Like RunPod, the fake needs the start and the end together.
        if (
          !url.searchParams.get('startTime') ||
          !url.searchParams.get('endTime')
        ) {
          json(400, {
            title: 'Bad Request',
            status: 400,
            detail: 'startTime and endTime must be provided together',
          });
          return;
        }
        json(200, {
          records: mode.billed
            ? [
                {
                  podId: url.searchParams.get('podId'),
                  totalAmount: mode.billed,
                },
              ]
            : [],
          metadata: {},
        });
      } else
        json(404, { title: 'Not Found', status: 404, detail: 'no such pod' });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    pods,
    calls,
    mode,
    envs,
  };
}

/**
 * A project with a stored key, limits, and a clock that the test moves.
 * `options.clock` lets projects share one clock, and `options.month` gives
 * the project the monthly limit across projects.
 */
async function setup(
  t: test.TestContext,
  limits: Record<string, unknown> = {},
  options: {
    readonly clock?: { now: number };
    readonly month?: (root: string) => MonthHooks;
  } = {},
): Promise<{
  root: string;
  compute: Compute;
  api: Awaited<ReturnType<typeof fakeRunPod>>;
  clock: { now: number };
  lines: string[];
  restart: () => Promise<Compute>;
}> {
  const api = await fakeRunPod(t);
  const dir = await mkdtemp(join(tmpdir(), 'verifold-leases-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'project');
  await mkdir(root);
  // SSH answers at once with a host key; the fake API has no log, so the key is trusted on first use.
  const keyscan = join(dir, 'ssh-keyscan');
  await writeFile(
    keyscan,
    `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nprocess.stdout.write('[' + args.at(-1) + ']:' + args[args.indexOf('-p') + 1] + ' ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOmpawy8ACLANKLqK6tdKsFJ55Erhu5/b+MUJUrQrH1M\\n');\n`,
  );
  await chmod(keyscan, 0o755);
  // An ssh that answers every call, so the watchdog starts without a real connection.
  const ssh = join(dir, 'ssh');
  await writeFile(
    ssh,
    `#!/usr/bin/env node\nprocess.stdout.write('watching\\n');\n`,
  );
  await chmod(ssh, 0o755);
  const store = new KeyStore({
    home: join(dir, 'home'),
    platform: 'linux',
    secretTool: join(dir, 'none'),
  });
  const clock = options.clock ?? { now: Date.parse('2026-10-05T12:00:00Z') };
  const lines: string[] = [];
  const make = async (): Promise<Compute> => {
    const compute = new Compute(root, {
      store,
      url: api.url,
      programs: { keyscan, ssh },
      now: () => clock.now,
      onChange: (_lease, line) => lines.push(line),
      ...(options.month ? { month: options.month(root) } : {}),
    });
    await compute.load();
    return compute;
  };
  const compute = await make();
  await compute.setKey(key, true);
  await compute.saveSettings({
    limitUsd: '10',
    maxUsdPerHour: '0.5',
    maxHoursPerLease: '4',
    idleMinutes: '15',
    maxRunningPods: '1',
    diskGb: '50',
    images: 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404',
    gpuTypes: [
      'NVIDIA RTX A5000',
      'NVIDIA GeForce RTX 4090',
      'NVIDIA H100 80GB HBM3',
    ],
    ...limits,
  });
  return { root, compute, api, clock, lines, restart: make };
}

const ask = {
  by: 'coordinator' as const,
  gpu: 'NVIDIA RTX A5000',
  hours: 2,
  tasks: ['task-2'],
  reason: 'Train the small model on a GPU.',
};

/** Every file under a folder, as text. */
async function everything(folder: string): Promise<string> {
  const names = await readdir(folder, { recursive: true }).catch(() => []);
  return (
    await Promise.all(
      names.map((name) => readFile(join(folder, name), 'utf8').catch(() => '')),
    )
  ).join('\n');
}

await test('costs count running time at the rate with the disk, and the larger bill wins', () => {
  const start = Date.parse('2026-10-05T12:00:00Z');
  const lease = {
    state: 'stopped',
    diskGb: 50,
    rate: 0.27,
    hours: 4,
    billedUsd: null,
    deadline: new Date(start + 4 * 3_600_000).toISOString(),
    intervals: [
      {
        start: new Date(start).toISOString(),
        end: new Date(start + 3_600_000).toISOString(),
        rate: 0.27,
      },
      {
        start: new Date(start + 2 * 3_600_000).toISOString(),
        end: null,
        rate: 0.3,
      },
    ],
  } as unknown as Lease;
  const now = start + 2.5 * 3_600_000;
  const disk = diskRate(50);
  assert.ok(
    Math.abs(accrued(lease, now) - (0.27 + disk + (0.3 + disk) * 0.5)) < 1e-9,
  );
  assert.equal(spent({ ...lease, billedUsd: 5 }, now), 5);
  // An open lease holds its rate for the hours that are left.
  assert.ok(Math.abs(reserved(lease, now) - (0.27 + disk) * 1.5) < 1e-9);
  const total = budget([lease], 10, now);
  assert.ok(
    Math.abs((total.left ?? 0) - (10 - total.spent - total.reserved)) < 1e-9,
  );
  // Only running leases count toward the rate now.
  assert.equal(total.rate, 0);
});

await test('a request must fit the limits, and only the person approves it', async (t) => {
  const { compute, api, clock, lines } = await setup(t);
  const leases = compute.leases;
  await assert.rejects(
    leases.request({ ...ask, gpu: 'NVIDIA A40' }),
    /allowed GPU type/,
  );
  await assert.rejects(leases.request({ ...ask, hours: 5 }), /1 to 4 hours/);
  await assert.rejects(
    leases.request({ ...ask, tasks: [] }),
    /Name 1 to 4 tasks/,
  );
  await assert.rejects(leases.request({ ...ask, reason: ' ' }), /short reason/);
  await assert.rejects(
    leases.request({ ...ask, gpu: 'NVIDIA GeForce RTX 4090' }),
    /above the cap/,
  );
  await assert.rejects(
    leases.request({ ...ask, gpu: 'NVIDIA H100 80GB HBM3' }),
    /no NVIDIA H100 80GB HBM3 in stock/,
  );
  // Nothing reached RunPod but catalog reads.
  assert.ok(
    api.calls.every(
      (call) =>
        call.startsWith('GET /v2/catalog') ||
        call.startsWith('GET /v2/pods?limit=1'),
    ),
  );
  const lease = await leases.request(ask);
  assert.equal(lease.state, 'requested');
  assert.equal(lease.rate, 0.27);
  assert.match(lease.podName, /^vf-[0-9a-f]{8}-lease-1-[0-9a-f]{4}$/);
  assert.match(
    lines.at(-1) ?? '',
    /The coordinator asked for a NVIDIA RTX A5000 pod for 2 hours at \$0\.27 per hour/,
  );
  assert.equal(api.pods.size, 0);
  // The person approves: Verifold creates the pod and counts from now.
  const approved = await leases.approve(lease.id);
  assert.equal(approved.state, 'starting');
  assert.equal(approved.podId, 'pod1');
  assert.equal(
    approved.deadline,
    new Date(clock.now + 2 * 3_600_000).toISOString(),
  );
  await assert.rejects(leases.approve(lease.id), /does not wait for approval/);
  // A second pod would pass the limit of one pod at a time.
  const second = await leases.request({ ...ask, tasks: ['task-3'] });
  await assert.rejects(leases.approve(second.id), /1 pod runs already/);
  await leases.deny(second.id);
  assert.equal(leases.get(second.id).state, 'denied');
  // Reads move the pod to RUNNING with SSH: the lease is ready.
  await leases.poll();
  await leases.poll();
  assert.equal(leases.get(lease.id).state, 'ready');
  assert.deepEqual(leases.get(lease.id).ssh, {
    host: '203.0.113.7',
    port: 22001,
  });
});

await test('Verifold stops an idle pod, starts it again, and deletes it at the end of the lease', async (t) => {
  const { compute, api, clock } = await setup(t);
  const leases = compute.leases;
  const id = (await leases.request(ask)).id;
  await leases.approve(id);
  await leases.poll();
  await leases.poll();
  assert.equal(leases.get(id).state, 'ready');
  clock.now += 14 * 60_000;
  await leases.poll();
  assert.equal(leases.get(id).state, 'ready');
  clock.now += 2 * 60_000;
  await leases.poll();
  let lease = leases.get(id);
  assert.equal(lease.state, 'stopped');
  assert.equal(lease.history.at(-1)?.by, 'idle');
  assert.equal(api.pods.get('pod1')?.status, 'EXITED');
  // 16 minutes at $0.27 per hour with the disk.
  assert.ok(
    Math.abs(spent(lease, clock.now) - (0.27 + diskRate(50)) * (16 / 60)) <
      1e-6,
  );
  await leases.start(id, 'coordinator', 'the next run needs it.');
  assert.equal(leases.get(id).state, 'starting');
  await leases.poll();
  await leases.poll();
  lease = leases.get(id);
  assert.equal(lease.state, 'ready');
  assert.equal(lease.ssh?.port, 22101);
  // The deadline does not move with a start.
  clock.now = Date.parse(lease.deadline ?? '') + 1000;
  await leases.poll();
  lease = leases.get(id);
  assert.equal(lease.state, 'ended');
  assert.equal(lease.end?.by, 'deadline');
  assert.equal(api.pods.size, 0);
  assert.ok(lease.intervals.every((interval) => interval.end));
});

await test('the spend limit, a rate above the cap, and a failed create end the lease, with a notice', async (t) => {
  const { compute, api, clock } = await setup(t);
  const leases = compute.leases;
  // RunPod bills more than Verifold counted: the larger amount reaches the limit.
  const first = (await leases.request(ask)).id;
  await leases.approve(first);
  await leases.poll();
  await leases.poll();
  api.mode.billed = 9.99;
  clock.now += 16 * 60_000;
  await leases.active(first);
  await leases.poll();
  let lease = leases.get(first);
  assert.equal(lease.billedUsd, 9.99);
  await leases.poll();
  lease = leases.get(first);
  assert.equal(lease.state, 'ended');
  assert.equal(lease.end?.by, 'limit');
  assert.match(lease.notice ?? '', /spend limit of \$10\.00 is reached/);
  await leases.dismiss(first);
  assert.equal(leases.get(first).notice, null);

  // A pod that bills above the cap is deleted at once.
  await compute.saveSettings({
    limitUsd: '100',
    maxUsdPerHour: '0.5',
    maxHoursPerLease: '4',
    idleMinutes: '15',
    maxRunningPods: '1',
    diskGb: '50',
    images: 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404',
  });
  api.mode.billed = 0;
  api.mode.cost = 0.9;
  const second = (await leases.request(ask)).id;
  await leases.approve(second);
  await leases.poll();
  await leases.poll();
  lease = leases.get(second);
  assert.equal(lease.state, 'ended');
  assert.match(lease.notice ?? '', /above your cap/);

  // No capacity: nothing is created, and the lease failed.
  api.mode.cost = 0.27;
  api.mode.create = 'capacity';
  const third = (await leases.request(ask)).id;
  lease = await leases.approve(third);
  assert.equal(lease.state, 'failed');
  assert.match(lease.notice ?? '', /no capacity for this GPU/);
  assert.equal(api.pods.size, 0);
});

await test('recovery adopts a pod whose create reply was lost, and stops a pod that outlived Verifold', async (t) => {
  const { root, compute, api, clock, restart } = await setup(t);
  // The reply is lost after RunPod created the pod. Verifold finds it by its name.
  api.mode.create = 'lost';
  const id = (await compute.leases.request(ask)).id;
  const lease = await compute.leases.approve(id);
  assert.equal(lease.state, 'starting');
  assert.equal(lease.podId, 'pod1');
  await compute.leases.poll();
  await compute.leases.poll();
  assert.equal(compute.leases.get(id).state, 'ready');
  // Verifold crashes and starts an hour later. The pod still runs and bills.
  clock.now += 60 * 60_000;
  const later = await restart();
  await later.leases.recover();
  const recovered = later.leases.get(id);
  assert.equal(recovered.state, 'stopped');
  assert.equal(api.pods.get('pod1')?.status, 'EXITED');
  assert.match(
    recovered.notice ?? '',
    /ran while Verifold was not running, so Verifold stopped it\. That time cost about \$0\.2[78]/,
  );
  // On exit, running pods stop.
  await later.leases.start(id, 'person', 'again');
  await later.leases.poll();
  await later.leases.poll();
  assert.deepEqual(await later.close(), []);
  assert.equal(later.leases.get(id).state, 'stopped');
  // A pod's env and the key are in no record.
  const records = await everything(join(root, '.verifold'));
  assert.doesNotMatch(records, /FAKETOKEN|TESTKEY/);
});

await test('Needs you shows a request with its cost and limits, and Compute and Home show the pods', async (t) => {
  const { compute } = await setup(t);
  const snapshot = {
    workspace: {
      schemaVersion: 1 as const,
      visibility: 'private' as const,
      profile: {
        name: 'R',
        interests: ['x'],
        scholar: '',
        github: '',
        session: '',
      },
      host: 'claude',
      candidates: [],
      selectedId: null,
    },
    attempts: [],
  };
  const render = (view: string): ReturnType<typeof renderDesk> => {
    const frame = parseFrame(view, null);
    assert.ok(frame);
    return renderDesk(
      snapshot as never,
      undefined,
      null,
      { session: null, controllable: true, compute: compute.view() },
      frame,
    );
  };
  const lease = await compute.leases.request(ask);
  let page = render('needs');
  assert.deepEqual(
    page.needs.map((need) => need.key),
    [`lease:${lease.id}`],
  );
  assert.match(page.html, /The coordinator asks for a NVIDIA RTX A5000 pod/);
  // The request names its task by title.
  const titled = renderDesk(
    snapshot as never,
    undefined,
    null,
    {
      session: null,
      controllable: true,
      compute: compute.view(),
      tasks: {
        list: [
          {
            id: 'task-2',
            state: 'running',
            attempts: [],
            assignment: { title: 'Train the small model', dependencies: [] },
          },
        ],
        selected: null,
        idle: [],
        messages: [],
      },
    } as never,
    { view: 'needs', panel: null },
  ).html;
  assert.match(titled, /<dt>For<\/dt><dd>Train the small model<\/dd>/);
  assert.match(page.html, /\$0\.27 per hour/);
  assert.match(
    page.html,
    /<span class="tag reading">The coordinator says<\/span> Train the small model on a GPU\./,
  );
  assert.match(page.html, /runs any command as root, with internet access/);
  assert.match(
    page.html,
    /data-action="compute-lease-approve" data-lease="lease-1">Approve, up to \$0\.55</,
  );
  // The rail counts the request on Compute.
  assert.match(page.html, /data-view="compute">[\s\S]*?<span class="n">/);
  await compute.leases.approve(lease.id);
  await compute.leases.poll();
  await compute.leases.poll();
  page = render('compute');
  assert.equal(page.needs.length, 0);
  assert.match(
    page.html,
    /<tr data-state="ready"><th scope="row">task-2<\/th><td>NVIDIA RTX A5000<\/td>[\s\S]*?\$0\.28 per hour/,
  );
  assert.match(
    page.html,
    /data-action="compute-lease-stop" data-lease="lease-1"/,
  );
  assert.match(
    page.html,
    /Held for running pods \$0\.55\. Left \$9\.45 of \$10\.00\./,
  );
  page = render('home');
  assert.match(
    page.html,
    /1 pod runs at \$0\.28 per hour\. Spent \$0\.00 of \$10\.00\./,
  );
  assert.doesNotMatch(JSON.stringify(page), /TESTKEY|FAKETOKEN/);
});

await test('a pod gets the secrets that its request names, and a missing secret waits in Needs you', async (t) => {
  const { root, compute, api, lines } = await setup(t);
  const value = 'hf_SECRETVALUE0123456789';
  const render = (view: string): ReturnType<typeof renderDesk> => {
    const frame = parseFrame(view, null);
    assert.ok(frame);
    return renderDesk(
      {
        workspace: {
          schemaVersion: 1 as const,
          visibility: 'private' as const,
          profile: {
            name: 'R',
            interests: ['x'],
            scholar: '',
            github: '',
            session: '',
          },
          host: 'claude',
          candidates: [],
          selectedId: null,
        },
        attempts: [],
      } as never,
      undefined,
      null,
      { session: null, controllable: true, compute: compute.view() },
      frame,
    );
  };
  await assert.rejects(
    compute.leases.request({ ...ask, secrets: ['hf_token'] }),
    /Name up to 8 secrets/,
  );
  await assert.rejects(
    compute.leases.request({ ...ask, secrets: ['PUBLIC_KEY'] }),
    /Name up to 8 secrets/,
  );
  const lease = await compute.leases.request({
    ...ask,
    secrets: ['HF_TOKEN'],
  });
  assert.deepEqual(lease.secrets, ['HF_TOKEN']);
  assert.deepEqual(compute.missingSecrets(lease), ['HF_TOKEN']);
  // Without the secret, the pod does not start, and the request waits.
  await assert.rejects(
    compute.leases.approve(lease.id, 'verifold'),
    /Store the secret HF_TOKEN first, with `verifold runpod secret set NAME`\. The pod of lease-1 needs it\./,
  );
  assert.equal(compute.leases.get(lease.id).state, 'requested');
  assert.ok(!api.calls.includes('POST /v2/pods'));
  let page = render('needs');
  assert.deepEqual(
    page.needs.map((need) => need.key),
    [`lease-secret:${lease.id}`],
  );
  assert.match(page.html, /Add a secret: HF_TOKEN/);
  assert.match(
    page.html,
    /<button type="button" class="primary" data-view="compute">Add it in Compute<\/button>/,
  );
  page = render('compute');
  assert.match(
    page.html,
    /The pod for task-2 waits for <code>HF_TOKEN<\/code>/,
  );
  assert.match(page.html, /id="secret-name"[^>]*value="HF_TOKEN"/);
  assert.match(page.html, /<input id="secret-value" type="password"/);

  // Storing the secret starts the request, which fits the limits, with the secret on the pod.
  api.mode.secrets = ['HF_TOKEN'];
  await compute.setSecret('HF_TOKEN', value, true);
  assert.equal(compute.leases.get(lease.id).state, 'starting');
  assert.equal(api.envs.at(-1)?.HF_TOKEN, value);
  assert.deepEqual(
    compute.view().secrets.map((secret) => [secret.name, secret.place]),
    [['HF_TOKEN', 'file']],
  );
  page = render('compute');
  assert.match(
    page.html,
    /<code>HF_TOKEN<\/code> <span class="fine">in a private file/,
  );
  assert.match(
    page.html,
    /data-action="compute-secret-remove" data-secret="HF_TOKEN"/,
  );
  // A secret that an open pod has stays until the lease ends.
  await assert.rejects(compute.removeSecret('HF_TOKEN'), /End lease-1 first/);
  // No record, line, or page holds the value.
  assert.doesNotMatch(await everything(root), /SECRETVALUE/);
  assert.doesNotMatch(lines.join('\n'), /SECRETVALUE/);
  assert.doesNotMatch(JSON.stringify(render('compute')), /SECRETVALUE/);
  await compute.leases.end(lease.id, 'person', 'done.');
  await compute.removeSecret('HF_TOKEN');
  assert.deepEqual(compute.view().secrets, []);
});

await test('when the person approves each pod, a new secret leaves the request for the person', async (t) => {
  const { compute, api } = await setup(t, { askBeforePod: true });
  const lease = await compute.leases.request({
    ...ask,
    secrets: ['WANDB_API_KEY'],
  });
  await compute.setSecret('WANDB_API_KEY', 'wandb0123456789abcdef', true);
  assert.equal(compute.leases.get(lease.id).state, 'requested');
  assert.ok(!api.calls.includes('POST /v2/pods'));
  assert.deepEqual(compute.missingSecrets(compute.leases.get(lease.id)), []);
});

await test('the monthly limit refuses a pod that does not fit, counts every project, follows the profile, and starts at zero in a new month', async (t) => {
  const agency = await mkdtemp(join(tmpdir(), 'verifold-agency-'));
  t.after(() => rm(agency, { recursive: true, force: true }));
  const limit: { usd: number | null } = { usd: 2 };
  // Local time: the month is a calendar month on this computer.
  const clock = { now: new Date(2026, 9, 30, 12, 0).getTime() };
  const month = (root: string): MonthHooks =>
    new GpuMonth({ agency, root, limit: () => Promise.resolve(limit.usd) });
  const first = await setup(t, {}, { clock, month });
  const second = await setup(t, {}, { clock, month });
  const hourly = 0.27 + diskRate(50);
  // The first project holds a pod for 4 hours: $1.11 of the $2.
  const held = await first.compute.leases.request({ ...ask, hours: 4 });
  await first.compute.leases.approve(held.id);
  assert.ok(
    Math.abs((first.compute.view().month?.heldUsd ?? 0) - hourly * 4) < 1e-6,
  );
  // The other project counts it: a pod for 4 hours does not fit, one for 2 hours does.
  await assert.rejects(
    second.compute.leases.request({ ...ask, hours: 4 }),
    /The pod can cost up to \$1\.11, but only \$0\.89 is left of your monthly GPU limit of \$2\.00 across projects: \$0\.00 spent this month and \$1\.11 held by open pods\. Raise the limit in your profile, under GPU money\.$/,
  );
  const waiting = await second.compute.leases.request({ ...ask, hours: 2 });
  // The limit comes from the profile at each check: a lower one refuses the approval.
  limit.usd = 1.5;
  await assert.rejects(
    second.compute.leases.approve(waiting.id),
    /only \$0\.39 is left of your monthly GPU limit of \$1\.50/,
  );
  // Without a monthly limit, only the project's own limit applies.
  limit.usd = null;
  assert.equal(
    (await second.compute.leases.approve(waiting.id)).state,
    'starting',
  );
  assert.equal(second.compute.view().month, null);
  // Each project keeps its own record in the profile.
  assert.equal(
    (await readdir(monthFolder(agency))).filter((name) =>
      /^[0-9a-f]{16}\.json$/.test(name),
    ).length,
    2,
  );
  // Three hours later both pods end: October spent $1.67 (the other project's record rounds up to the cent), so a pod for 4 hours no longer fits.
  limit.usd = 2;
  clock.now += 3 * 3_600_000;
  await first.compute.leases.end(held.id, 'person', 'done.');
  await second.compute.leases.end(waiting.id, 'person', 'done.');
  await assert.rejects(
    first.compute.leases.request({ ...ask, hours: 4 }),
    /\$1\.67 spent this month and \$0\.00 held/,
  );
  // In November, October's pods count no more.
  clock.now = new Date(2026, 10, 1, 0, 30).getTime();
  assert.equal(
    (await first.compute.leases.request({ ...ask, hours: 4 })).state,
    'requested',
  );
  assert.equal(first.compute.view().month?.spentUsd, 0);
});

await test('when all projects together reach the monthly limit, the running pods end with a notice', async (t) => {
  const agency = await mkdtemp(join(tmpdir(), 'verifold-agency-'));
  t.after(() => rm(agency, { recursive: true, force: true }));
  const clock = { now: new Date(2026, 9, 12, 12, 0).getTime() };
  const { compute, api } = await setup(
    t,
    { limitUsd: '100' },
    {
      clock,
      month: (root) =>
        new GpuMonth({ agency, root, limit: () => Promise.resolve(5) }),
    },
  );
  // Another project spent $4 this month, and its pods ended.
  await prepareAgency(agency);
  await mkdir(monthFolder(agency), { mode: 0o700 });
  await writeFile(
    join(monthFolder(agency), '0123456789abcdef.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: '/elsewhere',
      month: '2026-10',
      writtenAt: new Date(clock.now).toISOString(),
      endedUsd: 4,
      open: [],
    }),
  );
  const id = (await compute.leases.request(ask)).id;
  await compute.leases.approve(id);
  await compute.leases.poll();
  await compute.leases.poll();
  assert.equal(compute.leases.get(id).state, 'ready');
  // RunPod bills $0.99 for this pod: with the other project's $4, the month reaches the limit.
  api.mode.billed = 0.99;
  clock.now += 16 * 60_000;
  await compute.leases.active(id);
  await compute.leases.poll();
  await compute.leases.poll();
  const lease = compute.leases.get(id);
  assert.equal(lease.state, 'ended');
  assert.equal(lease.end?.by, 'limit');
  assert.equal(
    lease.notice,
    `Verifold ended ${id}: your projects reached the monthly GPU limit of $5.00, with $4.99 spent this month. Raise the limit in your profile, under GPU money.`,
  );
  // The record of this project now says what it spent, for the other projects.
  const records = (await readdir(monthFolder(agency))).filter(
    (name) => name !== '0123456789abcdef.json' && name.endsWith('.json'),
  );
  assert.equal(records.length, 1);
  const own = JSON.parse(
    await readFile(join(monthFolder(agency), records[0] ?? ''), 'utf8'),
  ) as { month: string; endedUsd: number; open: unknown[] };
  assert.equal(own.month, '2026-10');
  assert.equal(own.endedUsd, 0.99);
  assert.deepEqual(own.open, []);
  // Spend past the limit leaves nothing to rent: the agents never see a negative figure.
  await writeFile(
    join(monthFolder(agency), '0123456789abcdef.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: '/elsewhere',
      month: '2026-10',
      writtenAt: new Date(clock.now).toISOString(),
      endedUsd: 10,
      open: [],
    }),
  );
  await compute.leases.refreshMonth();
  const state = JSON.parse(await compute.describe()) as {
    monthAllProjects: { leftUsd: number };
  };
  assert.equal(state.monthAllProjects.leftUsd, 0);
});

await test("a record that cannot be saved, and another project's record that cannot be read, show in Compute", async (t) => {
  const agency = await mkdtemp(join(tmpdir(), 'verifold-agency-'));
  t.after(() => rm(agency, { recursive: true, force: true }));
  // A folder that holds other files is not a Verifold profile, so the record is refused.
  await writeFile(join(agency, 'notes.txt'), 'not Verifold');
  const { compute, clock } = await setup(
    t,
    {},
    {
      month: (root) =>
        new GpuMonth({ agency, root, limit: () => Promise.resolve(50) }),
    },
  );
  // A pod that runs holds money, so its project records it.
  const id = (await compute.leases.request(ask)).id;
  await compute.leases.approve(id);
  assert.match(
    compute.view().problem?.text ?? '',
    /could not save this project's GPU spend for the monthly limit, so your other projects do not count it: Choose an empty agency directory/,
  );
  // Without the stray file, the next change saves the record of the pod's ten minutes, and the problem goes.
  await rm(join(agency, 'notes.txt'));
  clock.now += 10 * 60_000;
  await compute.leases.end(id, 'person', 'done.');
  assert.equal(compute.view().problem, null);
  // A record of another project that cannot be read, with no earlier read: Verifold cannot tell that spend, so no new pod starts.
  const broken = join(monthFolder(agency), 'abcdefabcdefabcd.json');
  await writeFile(broken, '{');
  const line = `Verifold can't read ${broken}, the GPU record of another project, so it can't tell what that project spent, and no new pod starts. If that project no longer exists, remove the file. If it does, open Verifold in that project, so it writes the file again.`;
  await assert.rejects(compute.leases.request(ask), (error: Error) => {
    assert.equal(error.message, line);
    return true;
  });
  assert.equal(compute.view().problem?.text, line);
  assert.equal(compute.view().month, null);
});

await test('a pod that runs past the end of a month counts in the new month, for its own project and for the others', async (t) => {
  const agency = await mkdtemp(join(tmpdir(), 'verifold-agency-'));
  t.after(() => rm(agency, { recursive: true, force: true }));
  const clock = { now: new Date(2026, 9, 31, 23, 0).getTime() };
  const month = (root: string): MonthHooks =>
    new GpuMonth({ agency, root, limit: () => Promise.resolve(2) });
  const first = await setup(t, {}, { clock, month });
  const second = await setup(t, {}, { clock, month });
  const hourly = 0.27 + diskRate(50);
  const id = (await first.compute.leases.request({ ...ask, hours: 4 })).id;
  await first.compute.leases.approve(id);
  await first.compute.leases.poll();
  await first.compute.leases.poll();
  assert.equal(first.compute.leases.get(id).state, 'ready');
  // Half past midnight on November 1: the pod still runs a job, so it counts in November.
  clock.now = new Date(2026, 10, 1, 0, 30).getTime();
  await first.compute.leases.active(id);
  await first.compute.leases.poll();
  assert.equal(first.compute.leases.get(id).state, 'ready');
  const own = first.compute.view().month;
  assert.ok(Math.abs((own?.spentUsd ?? 0) - hourly * 1.5) < 1e-6);
  assert.ok(Math.abs((own?.heldUsd ?? 0) - hourly * 2.5) < 1e-6);
  // Its owner wrote the record at this time, which the test's clock sets.
  for (const name of await readdir(monthFolder(agency)))
    await utimes(
      join(monthFolder(agency), name),
      new Date(clock.now),
      new Date(clock.now),
    );
  // The other project counts it too: $0.42 spent and $0.70 held leave $0.88 of the $2.
  await assert.rejects(
    second.compute.leases.request({ ...ask, hours: 4 }),
    /only \$0\.88 is left of your monthly GPU limit of \$2\.00 across projects: \$0\.42 spent this month and \$0\.70 held by open pods/,
  );
});

await test('a profile that Verifold cannot read, or GPU limits in it that are not valid, stop new pods and show why', async (t) => {
  const agency = await mkdtemp(join(tmpdir(), 'verifold-agency-'));
  t.after(() => rm(agency, { recursive: true, force: true }));
  // The limit comes from the profile, as the owner reads it.
  const { compute } = await setup(
    t,
    {},
    { month: (root) => new GpuMonth({ agency, root }) },
  );
  // GPU limits that cannot be read: no new pod, although the first run shows the defaults.
  await saveAgencyFile(
    agency,
    'settings.json',
    JSON.stringify({
      host: 'claude',
      money: { ...profileMoneyDefaults, monthUsd: 'a lot' },
    }),
  );
  const limits =
    "Your GPU limits in the profile can't be read. Set them again under GPU money.";
  await assert.rejects(compute.leases.request(ask), (error: Error) => {
    assert.equal(error.message, limits);
    return true;
  });
  assert.equal(compute.view().problem?.text, limits);
  // A profile that cannot be read at all stops new pods too, with no limit read before.
  await saveAgencyFile(agency, 'settings.json', '{ not json');
  await assert.rejects(
    compute.leases.request(ask),
    /Verifold can't read your profile, so no new pod starts until it can check your monthly GPU limit: /,
  );
  assert.match(
    compute.view().problem?.text ?? '',
    /^Verifold can't read your profile/,
  );
  // Limits that read again: the pod fits, and the problem goes.
  await saveAgencyFile(
    agency,
    'settings.json',
    JSON.stringify({
      host: 'claude',
      money: { ...profileMoneyDefaults, monthUsd: 50 },
    }),
  );
  assert.equal((await compute.leases.request(ask)).state, 'requested');
  assert.equal(compute.view().problem, null);
});

await test('each poll reads the month once, with or without pods, in the queue', async (t) => {
  const agency = await mkdtemp(join(tmpdir(), 'verifold-agency-'));
  t.after(() => rm(agency, { recursive: true, force: true }));
  let reads = 0;
  const { compute } = await setup(
    t,
    {},
    {
      month: (root) => {
        const inner = new GpuMonth({
          agency,
          root,
          limit: () => Promise.resolve(50),
        });
        return {
          others: (now) => {
            reads++;
            return inner.others(now);
          },
          record: (leases, now) => inner.record(leases, now),
        };
      },
    },
  );
  reads = 0;
  await compute.leases.poll();
  assert.equal(reads, 1);
  const id = (await compute.leases.request(ask)).id;
  await compute.leases.approve(id);
  reads = 0;
  await compute.leases.poll();
  assert.equal(reads, 1);
});

await test("verifold pods keeps the project's record for the monthly limit, like the owner does", async (t) => {
  const { root, compute, clock } = await setup(t);
  // Started by a Compute without the monthly limit, so nothing wrote a record yet.
  const id = (await compute.leases.request(ask)).id;
  await compute.leases.approve(id);
  clock.now += 30 * 60_000;
  const home = await mkdtemp(join(tmpdir(), 'verifold-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const saved = process.env.HOME;
  t.after(() => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  });
  process.env.HOME = home;
  const out: string[] = [];
  await runCli(['pods'], root, {
    interactive: false,
    ask: () => Promise.reject(new Error('Unexpected prompt')),
    out: (text) => {
      out.push(text);
    },
  });
  assert.equal(
    (JSON.parse(out[0] ?? '[]') as { lease: string }[])[0]?.lease,
    id,
  );
  const gpu = join(home, '.verifold', 'agency', 'gpu');
  const [name] = (await readdir(gpu)).filter((entry) =>
    entry.endsWith('.json'),
  );
  const record = JSON.parse(await readFile(join(gpu, name ?? ''), 'utf8')) as {
    open: { id: string }[];
  };
  assert.deepEqual(
    record.open.map((entry) => entry.id),
    [id],
  );
});
