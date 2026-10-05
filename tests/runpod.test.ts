import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RunPod } from '../src/cli/runpod.ts';
import { Compute, computeDefaults } from '../src/cli/compute.ts';
import { KeyStore } from '../src/cli/credentials.ts';
import { runCli } from '../src/cli/commands.ts';
import { startDesk } from '../src/cli/desk.ts';
import { renderDesk, parseFrame } from '../src/cli/desk-view.ts';
import { SessionPool } from '../src/cli/workers.ts';
import { changeWorkspace } from '../src/cli/storage.ts';

const key = 'rpa_TESTKEY0123456789abcdefWXYZ';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

/**
 * A fake RunPod API: the pod list for key checks and the GPU catalog. It logs
 * every request. `mode` scripts a fault: an unknown key, a rate limit, or a
 * redirect to another host.
 */
async function fakeRunPod(t: test.TestContext): Promise<{
  url: string;
  seen: Seen[];
  mode: { value: 'ok' | 'limited' | 'redirect'; to?: string };
}> {
  const seen: Seen[] = [];
  const mode: { value: 'ok' | 'limited' | 'redirect'; to?: string } = {
    value: 'ok',
  };
  const server = createServer((request: IncomingMessage, response) => {
    seen.push({
      method: request.method ?? '',
      url: request.url ?? '',
      authorization: request.headers.authorization,
    });
    const json = (status: number, value: unknown, headers = {}): void => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        ...headers,
      });
      response.end(JSON.stringify(value));
    };
    if (mode.value === 'redirect') {
      response.writeHead(302, { Location: `${mode.to}/steal` }).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${key}`) {
      // A careless API could echo the key. Verifold must not repeat it.
      json(401, {
        title: 'Unauthorized',
        status: 401,
        detail: `invalid key ${request.headers.authorization ?? ''}`,
      });
      return;
    }
    if (mode.value === 'limited') {
      json(
        429,
        { title: 'Too Many Requests', status: 429, detail: 'slow down' },
        { 'Retry-After': '30' },
      );
      return;
    }
    if (request.url === '/v2/pods?limit=1') {
      json(200, { pods: [], pagination: { hasNextPage: false } });
      return;
    }
    if (
      request.url ===
      '/v2/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE&count=1'
    ) {
      json(200, {
        gpus: [
          {
            id: 'NVIDIA GeForce RTX 4090',
            name: 'RTX 4090',
            memory: 24,
            secure: true,
            community: true,
            price: { secure: 0.74, community: 0.34 },
            availability: 'HIGH',
          },
          {
            id: 'NVIDIA RTX A5000',
            name: 'RTX A5000',
            memory: 24,
            secure: true,
            community: true,
            price: { secure: 0.27, community: 0.16 },
            availability: 'LOW',
          },
          // Not on Secure Cloud, although the catalog gives a secure price.
          {
            id: 'NVIDIA GeForce RTX 3090 Ti',
            name: 'RTX 3090 Ti',
            memory: 24,
            secure: false,
            community: true,
            price: { secure: 0.46, community: 0.3 },
          },
          // A price of 0 is not a price.
          {
            id: 'NVIDIA A100-SXM4-40GB',
            name: 'A100 SXM 40GB',
            memory: 40,
            secure: true,
            community: false,
            price: { secure: 0, community: 0 },
          },
          {
            id: 'NVIDIA H100 80GB HBM3',
            name: 'H100 SXM',
            memory: 80,
            secure: true,
            community: true,
            price: { secure: 3.49, community: 2.69 },
            availability: 'NONE',
          },
        ],
      });
      return;
    }
    json(404, { title: 'Not Found', status: 404, detail: 'no route' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port.');
  return { url: `http://127.0.0.1:${address.port}`, seen, mode };
}

/** A project folder and a home folder whose key store has no keyring, so the key goes into a file. */
async function project(t: test.TestContext): Promise<{
  root: string;
  home: string;
  store: KeyStore;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'verifold-compute-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'project');
  const home = join(dir, 'home');
  await mkdir(root);
  const store = new KeyStore({
    home,
    platform: 'linux',
    secretTool: join(dir, 'no-secret-tool'),
  });
  return { root, home, store };
}

/** Every file under a folder, as text. */
async function everything(folder: string): Promise<string> {
  const names = await readdir(folder, { recursive: true }).catch(() => []);
  return (
    await Promise.all(
      names.map((name) => readFile(join(folder, name), 'utf8').catch(() => '')),
    )
  ).join('\n');
}

await test('the client sends the key only in the Authorization header and reads Secure Cloud GPUs', async (t) => {
  const api = await fakeRunPod(t);
  await new RunPod(key, api.url).check();
  assert.deepEqual(api.seen.at(-1), {
    method: 'GET',
    url: '/v2/pods?limit=1',
    authorization: `Bearer ${key}`,
  });
  assert.ok(api.seen.every((request) => !request.url.includes('TESTKEY')));
  // Types off Secure Cloud and zero prices drop out. The cheapest comes first.
  const gpus = await new RunPod(key, api.url).gpus();
  assert.deepEqual(
    gpus.map((gpu) => [gpu.id, gpu.price, gpu.stock]),
    [
      ['NVIDIA RTX A5000', 0.27, 'LOW'],
      ['NVIDIA GeForce RTX 4090', 0.74, 'HIGH'],
      ['NVIDIA H100 80GB HBM3', 3.49, 'NONE'],
    ],
  );
  // An error names the status and RunPod's reason, never the key.
  const wrong = 'rpa_WRONGKEY0123456789abcdef0000';
  await assert.rejects(new RunPod(wrong, api.url).check(), (error: Error) => {
    assert.match(error.message, /did not accept the key \(401\)/);
    assert.doesNotMatch(error.message, /WRONGKEY/);
    return true;
  });
  api.mode.value = 'limited';
  await assert.rejects(
    new RunPod(key, api.url).check(),
    /Try again in 30 seconds/,
  );
  // A redirect could carry the key to another host, so the client refuses it.
  const other = await fakeRunPod(t);
  api.mode.value = 'redirect';
  api.mode.to = other.url;
  await assert.rejects(
    new RunPod(key, api.url).check(),
    /could not reach RunPod/,
  );
  assert.equal(other.seen.length, 0);
});

await test('compute checks a key before it stores it, and keeps limits that only the person sets', async (t) => {
  const api = await fakeRunPod(t);
  const { root, home, store } = await project(t);
  const compute = new Compute(root, { store, url: api.url });
  await compute.load();
  assert.equal(compute.view().keyring, null);
  assert.equal(compute.view().settings.limitUsd, null);
  await assert.rejects(compute.setKey('short', true), /Paste a RunPod API key/);
  // Without a keyring, only a file that the person chose can hold the key.
  await assert.rejects(compute.setKey(key, false), /no keyring/);
  await assert.rejects(
    compute.setKey('rpa_WRONGKEY0123456789abcdef0000', true),
    /401/,
  );
  assert.equal(await store.status(), null);
  await compute.setKey(key, true);
  assert.equal(compute.view().key?.last4, 'WXYZ');
  assert.ok(compute.view().key?.checkedAt);
  await compute.checkKey();
  await compute.refreshGpus();
  assert.equal(compute.view().gpus?.length, 3);

  // Limits: RunPod images only, numbers in range, and the GPU list stays when the page sends none.
  const settings = {
    limitUsd: '25',
    maxUsdPerHour: '1.2',
    maxHoursPerLease: '3',
    idleMinutes: '20',
    maxRunningPods: '2',
    diskGb: '40',
    images: 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404\n',
    gpuTypes: ['NVIDIA RTX A5000'],
  };
  await assert.rejects(
    compute.saveSettings({ ...settings, images: 'ubuntu:24.04' }),
    /Use RunPod images/,
  );
  await assert.rejects(
    compute.saveSettings({ ...settings, maxHoursPerLease: '30' }),
    /hours of a lease as a whole number from 1 to 24/,
  );
  await compute.saveSettings(settings);
  const withoutGpus: Record<string, unknown> = { ...settings };
  delete withoutGpus.gpuTypes;
  await compute.saveSettings({ ...withoutGpus, limitUsd: '30' });
  const saved = compute.view().settings;
  assert.equal(saved.limitUsd, 30);
  assert.equal(saved.maxRunningPods, 2);
  assert.deepEqual(saved.gpuTypes, ['NVIDIA RTX A5000']);
  const file = join(root, '.verifold', 'compute', 'settings.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const again = new Compute(root, { store, url: api.url });
  await again.load();
  assert.deepEqual(again.view().settings, saved);
  // An empty limit turns pods off again.
  await compute.saveSettings({ ...withoutGpus, limitUsd: '' });
  assert.equal(compute.view().settings.limitUsd, null);

  // The key is in no project record and in no view.
  assert.doesNotMatch(await everything(join(root, '.verifold')), /TESTKEY/);
  assert.doesNotMatch(JSON.stringify(compute.view()), /TESTKEY/);
  assert.match(
    await readFile(join(home, '.verifold', 'credentials', 'runpod'), 'utf8'),
    /TESTKEY/,
  );
  await compute.removeKey();
  assert.equal(compute.view().key, null);
  await assert.rejects(compute.refreshGpus(), /Store a RunPod key first/);
});

await test('the Compute view shows the key status, the limits, and the GPUs, and never a key', () => {
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
  const frame = parseFrame('compute', null);
  assert.ok(frame);
  const live = {
    session: null,
    controllable: true,
    compute: {
      key: null,
      keyring: 'keychain' as const,
      settings: computeDefaults,
      gpus: null,
      gpusAt: null,
    },
  };
  let html = renderDesk(snapshot as never, undefined, null, live, frame).html;
  assert.match(html, /data-view="compute" aria-current="page"/);
  assert.match(
    html,
    /<input id="runpod-key" type="password" autocomplete="off"/,
  );
  assert.match(html, /instead of the macOS Keychain/);
  assert.match(html, /Pods stay off until you set a spend limit/);
  assert.match(html, /Store a RunPod key to see the GPUs/);
  html = renderDesk(
    snapshot as never,
    undefined,
    null,
    {
      ...live,
      compute: {
        key: {
          place: 'keychain' as const,
          last4: 'WXYZ',
          savedAt: new Date().toISOString(),
          checkedAt: new Date().toISOString(),
        },
        keyring: 'keychain' as const,
        settings: {
          ...computeDefaults,
          limitUsd: 25,
          gpuTypes: ['NVIDIA RTX A5000', 'Gone GPU'],
        },
        gpus: [
          {
            id: 'NVIDIA RTX A5000',
            name: 'RTX A5000',
            memoryGb: 24,
            price: 0.27,
            stock: 'LOW' as const,
          },
          {
            id: 'NVIDIA H100 80GB HBM3',
            name: 'H100 SXM',
            memoryGb: 80,
            price: 3.49,
            stock: 'NONE' as const,
          },
        ],
        gpusAt: new Date().toISOString(),
      },
    },
    frame,
  ).html;
  assert.match(
    html,
    /The key is in the macOS Keychain\. It ends in <code>WXYZ<\/code>/,
  );
  assert.match(html, /It worked at/);
  assert.match(html, /data-gpu="NVIDIA RTX A5000" checked/);
  assert.match(html, /\$3\.49 <span class="tag over-cap">Above your cap/);
  // An allowed type that RunPod does not offer now stays, so a save keeps it.
  assert.match(html, /data-gpu="Gone GPU" checked/);
  assert.match(html, /Not offered now/);
  assert.doesNotMatch(html, /Pods stay off/);
  // A desk without compute has no Compute view.
  const plain = renderDesk(
    snapshot as never,
    undefined,
    null,
    { session: null, controllable: false },
    frame,
  ).html;
  assert.doesNotMatch(plain, /data-view="compute"/);
});

await test('the desk stores a key and limits through actions, and no reply holds the key', async (t) => {
  const api = await fakeRunPod(t);
  const { root, store } = await project(t);
  await changeWorkspace(root, () => ({
    schemaVersion: 1,
    visibility: 'private',
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
  }));
  const assets = join(root, '..', 'assets');
  await mkdir(join(assets, 'cli', 'vendor'), { recursive: true });
  await mkdir(join(assets, 'ui'), { recursive: true });
  for (const name of [
    'desk.css',
    'desk-client.js',
    'desk-transcript.js',
    'desk-terminal.js',
    'desk-terminals.js',
    'desk-lease.js',
    'manrope.ttf',
    'symbol.webp',
  ])
    await writeFile(join(assets, 'cli', name), 'fixture asset');
  for (const name of ['purify.js', 'xterm.js', 'xterm.css', 'addon-fit.js'])
    await writeFile(join(assets, 'cli', 'vendor', name), 'fixture');
  await writeFile(join(assets, 'ui', 'dom.js'), 'fixture module');
  const compute = new Compute(root, { store, url: api.url });
  await compute.load();
  const owner = new AbortController();
  const desk = await startDesk(
    root,
    owner.signal,
    pathToFileURL(`${assets}/cli/`),
    new SessionPool(root, { clientVersion: 'test', ownerId: 'owner-1' }),
    undefined,
    undefined,
    undefined,
    undefined,
    compute,
  );
  t.after(async () => {
    owner.abort();
    await desk.closed;
  });
  const url = new URL(desk.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const post = async (
    body: unknown,
  ): Promise<{ status: number; text: string }> => {
    const response = await fetch(`${url.origin}/api/action`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  };
  const wrong = await post({
    action: 'compute-key-save',
    key: 'rpa_WRONGKEY0123456789abcdef0000',
    file: true,
  });
  assert.equal(wrong.status, 409);
  assert.match(wrong.text, /401/);
  assert.doesNotMatch(wrong.text, /WRONGKEY/);
  const saved = await post({ action: 'compute-key-save', key, file: true });
  assert.deepEqual(saved, { status: 200, text: '{"ok":true}' });
  assert.equal((await post({ action: 'compute-gpus' })).status, 200);
  assert.equal(
    (
      await post({
        action: 'compute-settings',
        limitUsd: '10',
        maxUsdPerHour: '1',
        maxHoursPerLease: '2',
        idleMinutes: '15',
        maxRunningPods: '1',
        diskGb: '50',
        images: 'runpod/base:1.0',
        gpuTypes: ['NVIDIA RTX A5000'],
      })
    ).status,
    200,
  );
  const bad = await post({ action: 'compute-settings', limitUsd: 'lots' });
  assert.equal(bad.status, 409);
  assert.match(bad.text, /spend limit/);
  const view = await (
    await fetch(`${url.origin}/api/view?view=compute`, { headers })
  ).text();
  assert.match(view, /It ends in <code>WXYZ<\/code>/);
  assert.match(view, /\$10 for this project/);
  assert.doesNotMatch(view, /TESTKEY/);
  assert.equal((await post({ action: 'compute-key-remove' })).status, 200);
  assert.equal((await post({ action: 'compute-unknown' })).status, 400);
});

await test('verifold runpod key stores, shows, checks, and removes the key without printing it', async (t) => {
  const api = await fakeRunPod(t);
  const { root, home } = await project(t);
  const out: string[] = [];
  const io = {
    interactive: false,
    ask: (): Promise<string> => Promise.reject(new Error('Unexpected prompt')),
    out: (text: string): void => {
      out.push(text);
    },
    readSecret: (): Promise<string> => Promise.resolve(`${key}\n`),
    compute: {
      url: api.url,
      store: {
        home,
        platform: 'linux' as const,
        secretTool: join(home, 'none'),
      },
    },
  };
  await assert.rejects(
    runCli(['runpod', 'key'], root, io),
    /runpod key set, status, check, or remove/,
  );
  await assert.rejects(
    runCli(['runpod', 'pods', 'set'], root, io),
    /runpod key set/,
  );
  await assert.rejects(
    runCli(['runpod', 'key', 'status', '--file'], root, io),
    /--file is valid only/,
  );
  await assert.rejects(
    runCli(['runpod', 'key', 'set'], root, io),
    /no keyring/,
  );
  await runCli(['runpod', 'key', 'set', '--file'], root, io);
  await runCli(['runpod', 'key', 'status'], root, io);
  await runCli(['runpod', 'key', 'check'], root, io);
  await runCli(['runpod', 'key', 'remove'], root, io);
  const replies = out.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  assert.deepEqual(
    replies.map((reply) => [reply.key, reply.place, reply.last4]),
    [
      ['stored', 'file', 'WXYZ'],
      ['stored', 'file', 'WXYZ'],
      ['stored', 'file', 'WXYZ'],
      ['none', undefined, undefined],
    ],
  );
  assert.doesNotMatch(out.join('\n'), /TESTKEY/);
});
