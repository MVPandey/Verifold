import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { runCli } from '../src/cli/commands.ts';
import { changeWorkspace, readJson } from '../src/cli/storage.ts';
import type { Workspace } from '../src/cli/contracts.ts';

const workspace: Workspace = {
  schemaVersion: 1,
  visibility: 'private',
  profile: {
    name: 'Fixture',
    interests: ['Math'],
    scholar: '',
    github: '',
    session: '',
  },
  host: 'claude',
  candidates: [],
  selectedId: null,
};

await test('initialization cannot append through a .gitignore symbolic link', async () => {
  const base = await mkdtemp(join(tmpdir(), 'verifold-security-'));
  try {
    const root = join(base, 'project');
    const target = join(base, 'unrelated');
    await mkdir(root);
    await writeFile(target, 'Original content');
    await symlink(target, join(root, '.gitignore'));
    await assert.rejects(changeWorkspace(root, () => workspace));
    assert.equal(await readFile(target, 'utf8'), 'Original content');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

await test('view and status reject a linked workspace directory before reading or writing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'verifold-security-'));
  try {
    const root = join(base, 'project');
    const target = join(base, 'unrelated');
    await mkdir(root);
    await mkdir(target);
    await writeFile(join(target, 'workspace.json'), JSON.stringify(workspace));
    await writeFile(join(target, 'workspace.html'), 'Original content');
    await symlink(target, join(root, '.verifold'));
    for (const command of ['view', 'status']) {
      await assert.rejects(
        runCli([command], root, {
          interactive: false,
          ask: () => Promise.resolve(''),
          out: () => assert.fail('Linked workspace must not be exposed.'),
        }),
        /symbolic link/,
      );
    }
    assert.equal(
      await readFile(join(target, 'workspace.html'), 'utf8'),
      'Original content',
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

await test(
  'JSON input rejects a FIFO without waiting for a writer',
  { timeout: 3000 },
  async () => {
    const base = await mkdtemp(join(tmpdir(), 'verifold-security-'));
    try {
      const fifo = join(base, 'input');
      await promisify(execFile)('mkfifo', [fifo]);
      await assert.rejects(readJson(fifo), /regular file/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);

await test('explicit JSON input can follow a user-selected file link', async () => {
  const base = await mkdtemp(join(tmpdir(), 'verifold-security-'));
  try {
    await writeFile(join(base, 'profile.json'), '{"name":"Fixture"}');
    await symlink(join(base, 'profile.json'), join(base, 'profile-link.json'));
    assert.deepEqual(await readJson(join(base, 'profile-link.json')), {
      name: 'Fixture',
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
