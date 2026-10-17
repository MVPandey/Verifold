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
import {
  KeyStore,
  validKey,
  validSecret,
  validSecretName,
} from '../src/cli/credentials.ts';
import { childEnvironment, storedSecretNames } from '../src/cli/harness.ts';

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

/** A fake keychain that keeps one value for each service and account, like `security`. */
const fakeKeychain = `#!/usr/bin/env node
const fs = require('node:fs');
const [dir, ...args] = [process.env.FAKE_DIR, ...process.argv.slice(2)];
fs.appendFileSync(dir + '/args.log', JSON.stringify(args) + '\\n');
const item = (service, account) => dir + '/item-' + service + '-' + account;
if (args[0] === '-i') {
  const line = fs.readFileSync(0, 'utf8');
  const match = /^add-generic-password -U -s (\\S+) -a (\\S+) -l "[^"]+" -w (\\S+)\\n$/.exec(line);
  if (!match) process.exit(1);
  fs.writeFileSync(item(match[1], match[2]), match[3]);
} else {
  const file = item(args[args.indexOf('-s') + 1], args[args.indexOf('-a') + 1]);
  if (!fs.existsSync(file)) process.exit(44);
  if (args[0] === 'find-generic-password') process.stdout.write(fs.readFileSync(file, 'utf8') + '\\n');
  else if (args[0] === 'delete-generic-password') fs.rmSync(file);
  else process.exit(2);
}
`;

await test('a secret name is an environment variable name that pods do not use, and a value needs no quoting', () => {
  for (const name of ['HF_TOKEN', 'WANDB_API_KEY', 'A'])
    assert.ok(validSecretName(name));
  for (const name of [
    'hf_token',
    '1TOKEN',
    'PUBLIC_KEY',
    'PATH',
    'RUNPOD_API_KEY',
    'LD_PRELOAD',
    'A'.repeat(65),
    42,
  ])
    assert.ok(!validSecretName(name));
  assert.ok(validSecret('hf_abcDEF0123+/=:@.-'));
  for (const bad of ['short', 'has space1', 'quote"12345', 'x'.repeat(1025)])
    assert.ok(!validSecret(bad));
});

await test('pod secrets go into the keychain by name, list without values, and leave every child environment', async (t) => {
  const { home, dir } = await fakes(t);
  await writeFile(join(dir, 'keychain'), fakeKeychain);
  await chmod(join(dir, 'keychain'), 0o755);
  const store = new KeyStore({
    home,
    platform: 'darwin',
    security: join(dir, 'keychain'),
  });
  const secrets = store.secrets();
  const value = 'hf_SECRETVALUE0123456789';
  assert.deepEqual(await secrets.list(), []);
  await assert.rejects(
    secrets.save('hf_token', value, 'keychain'),
    /secret name/,
  );
  await assert.rejects(
    secrets.save('HF_TOKEN', 'bad value', 'keychain'),
    /8 to 1024/,
  );
  await secrets.save('HF_TOKEN', value, 'keychain');
  await secrets.save('WANDB_API_KEY', 'wandb0123456789abcdef', 'file');
  assert.equal(await secrets.read('HF_TOKEN'), value);
  assert.equal(await secrets.read('WANDB_API_KEY'), 'wandb0123456789abcdef');
  assert.deepEqual(
    (await secrets.list()).map((secret) => [secret.name, secret.place]),
    [
      ['HF_TOKEN', 'keychain'],
      ['WANDB_API_KEY', 'file'],
    ],
  );
  // The RunPod key is a separate item.
  assert.equal(await store.read(), null);
  // No argument and no record holds the keychain value.
  assert.doesNotMatch(
    await readFile(join(dir, 'args.log'), 'utf8'),
    /SECRETVALUE/,
  );
  assert.doesNotMatch(await everything(join(home, '.verifold')), /SECRETVALUE/);
  assert.equal(
    (await stat(join(home, '.verifold', 'credentials', 'secret-WANDB_API_KEY')))
      .mode & 0o777,
    0o600,
  );

  // A child process loses variables named like a stored secret, as it loses RUNPOD_ variables.
  const saved = { HOME: process.env.HOME, HF_TOKEN: process.env.HF_TOKEN };
  t.after(() => {
    for (const [name, before] of Object.entries(saved))
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
  });
  process.env.HOME = home;
  process.env.HF_TOKEN = 'exported-by-the-person';
  assert.deepEqual(storedSecretNames().sort(), ['HF_TOKEN', 'WANDB_API_KEY']);
  assert.equal(childEnvironment().HF_TOKEN, undefined);

  await secrets.remove('HF_TOKEN');
  assert.equal(await secrets.read('HF_TOKEN'), null);
  assert.deepEqual(storedSecretNames(), ['WANDB_API_KEY']);
  assert.equal(childEnvironment().HF_TOKEN, 'exported-by-the-person');
});
