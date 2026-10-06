import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore, validKey } from '../src/cli/credentials.ts';

const key = 'rpa_TESTKEY0123456789abcdefWXYZ';

/**
 * Fake `security` and `secret-tool` programs. Each logs its arguments and keeps
 * one secret in a file, so a test can show that the key never was an argument.
 */
const fakeSecurity = `#!/usr/bin/env node
const fs = require('node:fs');
const [dir, ...args] = [process.env.FAKE_DIR, ...process.argv.slice(2)];
fs.appendFileSync(dir + '/args.log', JSON.stringify(args) + '\\n');
const secret = dir + '/secret';
if (args[0] === '-i') {
  const line = fs.readFileSync(0, 'utf8');
  const match = /^add-generic-password -U -s verifold\\.runpod -a default -l "Verifold RunPod key" -w (\\S+)\\n$/.exec(line);
  if (!match) process.exit(1);
  fs.writeFileSync(secret, match[1]);
} else if (args[0] === 'find-generic-password') {
  if (!fs.existsSync(secret)) process.exit(44);
  process.stdout.write(fs.readFileSync(secret, 'utf8') + '\\n');
} else if (args[0] === 'delete-generic-password') {
  if (!fs.existsSync(secret)) process.exit(44);
  fs.rmSync(secret);
} else process.exit(2);
`;
const fakeSecretTool = `#!/usr/bin/env node
const fs = require('node:fs');
const [dir, ...args] = [process.env.FAKE_DIR, ...process.argv.slice(2)];
fs.appendFileSync(dir + '/args.log', JSON.stringify(args) + '\\n');
const secret = dir + '/secret';
if (args[0] === 'store') fs.writeFileSync(secret, fs.readFileSync(0, 'utf8'));
else if (args[0] === 'lookup') {
  if (!fs.existsSync(secret)) process.exit(1);
  process.stdout.write(fs.readFileSync(secret, 'utf8'));
} else if (args[0] === 'clear') fs.rmSync(secret, { force: true });
else process.exit(2);
`;

async function fakes(t: test.TestContext): Promise<{
  home: string;
  dir: string;
  security: string;
  secretTool: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'verifold-keys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const security = join(dir, 'security');
  const secretTool = join(dir, 'secret-tool');
  await writeFile(security, fakeSecurity);
  await writeFile(secretTool, fakeSecretTool);
  await chmod(security, 0o755);
  await chmod(secretTool, 0o755);
  const saved = process.env.FAKE_DIR;
  process.env.FAKE_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.FAKE_DIR;
    else process.env.FAKE_DIR = saved;
  });
  return { home, dir, security, secretTool };
}

/** Every file under a folder, as text. */
async function everything(folder: string): Promise<string> {
  const names = await readdir(folder, { recursive: true }).catch(() => []);
  const texts = await Promise.all(
    names.map((name) => readFile(join(folder, name), 'utf8').catch(() => '')),
  );
  return texts.join('\n');
}

await test('a key has 20 to 256 letters, digits, and _.-', () => {
  assert.ok(validKey(key));
  for (const bad of ['short', `${key} x`, `${key}"`, `${key}\n`, 42, null])
    assert.ok(!validKey(bad));
});

await test('on macOS the key goes into the keychain on stdin, never as an argument', async (t) => {
  const { home, dir, security } = await fakes(t);
  const store = new KeyStore({ home, platform: 'darwin', security });
  assert.equal(await store.osPlace(), 'keychain');
  assert.equal(await store.status(), null);
  assert.equal(await store.read(), null);
  await store.save(key, 'keychain');
  assert.equal(await store.read(), key);
  const status = await store.status();
  assert.equal(status?.place, 'keychain');
  assert.equal(status?.last4, 'WXYZ');
  // The arguments of every call, and the record of where the key is, hold no key.
  assert.doesNotMatch(await readFile(join(dir, 'args.log'), 'utf8'), /TESTKEY/);
  assert.doesNotMatch(await everything(join(home, '.verifold')), /TESTKEY/);
  assert.equal(
    (await stat(join(home, '.verifold', 'credentials'))).mode & 0o777,
    0o700,
  );
  assert.equal(
    (await stat(join(home, '.verifold', 'credentials', 'runpod.json'))).mode &
      0o777,
    0o600,
  );
  await store.noteCheck('RunPod did not accept the key (401).');
  assert.match((await store.status())?.problem ?? '', /401/);
  await store.noteCheck(null);
  assert.equal((await store.status())?.problem, undefined);
  await store.remove();
  assert.equal(await store.status(), null);
  assert.equal(await store.read(), null);
});

await test('on Linux the key goes into the Secret Service, and without it into a file only by choice', async (t) => {
  const { home, dir, secretTool } = await fakes(t);
  const store = new KeyStore({ home, platform: 'linux', secretTool });
  assert.equal(await store.osPlace(), 'secret-service');
  await store.save(key, 'secret-service');
  assert.equal(await store.read(), key);
  assert.doesNotMatch(await readFile(join(dir, 'args.log'), 'utf8'), /TESTKEY/);
  await store.remove();
  assert.equal(await store.read(), null);

  // Without secret-tool, there is no keyring, and the person can choose a private file.
  const bare = new KeyStore({
    home,
    platform: 'linux',
    secretTool: join(dir, 'missing'),
  });
  assert.equal(await bare.osPlace(), null);
  await bare.save(key, 'file');
  const file = join(home, '.verifold', 'credentials', 'runpod');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await bare.read(), key);
  assert.equal((await bare.status())?.place, 'file');
  // A key file that others can read is refused.
  await chmod(file, 0o644);
  await assert.rejects(bare.read(), /other users can read it/);
  await bare.remove();
  await assert.rejects(stat(file), /ENOENT/);
});
