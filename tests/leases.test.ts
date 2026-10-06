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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compute } from '../src/cli/compute.ts';
import { parseFrame, renderDesk } from '../src/cli/desk-view.ts';
import { KeyStore } from '../src/cli/credentials.ts';
import {
  accrued,
  budget,
  diskRate,
  reserved,
  spent,
  type Lease,
} from '../src/cli/leases.ts';

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
  mode: { create: 'ok' | 'capacity' | 'lost'; cost: number; billed: number };
}> {
  const pods = new Map<string, FakePod>();
  const calls: string[] = [];
  const mode: {
    create: 'ok' | 'capacity' | 'lost';
    cost: number;
    billed: number;
  } = {
    create: 'ok',
    cost: 0.27,
    billed: 0,
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
        // The only variable is the lease's own SSH public key.
        assert.match(
          (input.env as Record<string, string>).PUBLIC_KEY ?? '',
          /^ssh-ed25519 \S+ verifold-lease-\d+$/,
        );
        assert.equal(Object.keys(input.env as object).length, 1);
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
  return { url: `http://127.0.0.1:${address.port}`, pods, calls, mode };
}

/** A project with a stored key, limits, and a clock that the test moves. */
async function setup(
  t: test.TestContext,
  limits: Record<string, unknown> = {},
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
  const clock = { now: Date.parse('2026-10-05T12:00:00Z') };
  const lines: string[] = [];
  const make = async (): Promise<Compute> => {
    const compute = new Compute(root, {
      store,
      url: api.url,
      programs: { keyscan, ssh },
      now: () => clock.now,
      onChange: (_lease, line) => lines.push(line),
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
  assert.match(page.html, /\$0\.27 per hour/);
  assert.match(
    page.html,
    /<span class="tag reading">Its reason<\/span> Train the small model on a GPU\./,
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
    /<tr data-state="ready"><th scope="row">lease-1<\/th>/,
  );
  assert.match(
    page.html,
    /data-action="compute-lease-stop" data-lease="lease-1"/,
  );
  assert.match(
    page.html,
    /Held for open leases \$0\.55\. Left \$9\.45 of \$10\.00\./,
  );
  page = render('home');
  assert.match(
    page.html,
    /1 pod runs at \$0\.28 per hour\. Spent \$0\.00 of \$10\.00\./,
  );
  assert.doesNotMatch(JSON.stringify(page), /TESTKEY|FAKETOKEN/);
});
