import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  loadAgency,
  loadMemory,
  personalize,
  prepareAgency,
  readMemory,
  saveAgencyFile,
} from '../src/cli/agency.ts';
import type { CliIO } from '../src/cli/commands.ts';
import type { runHarness } from '../src/cli/harness.ts';

async function temporary(
  run: (root: string, directory: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'verifold-agency-'));
  try {
    await run(root, join(root, 'agency'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function prompts(answers: string[], progress: string[] = []): CliIO {
  return {
    interactive: true,
    ask: () => {
      const answer = answers.shift();
      assert.notEqual(answer, undefined, 'Unexpected prompt');
      return Promise.resolve(answer ?? '');
    },
    out: () => {},
    progress: (message) => {
      progress.push(message);
    },
  };
}

const noHost: typeof runHarness = () => {
  assert.fail('The harness must not run without import consent.');
};

await test('import reads only after consent and scopes the host request to selected evidence', async () => {
  await temporary(async (root, directory) => {
    const source = join(root, 'conversation.txt');
    const questions: string[] = [];
    let calls = 0;
    const signal = new AbortController().signal;
    const io: CliIO = {
      ...prompts([]),
      ask: async (question) => {
        questions.push(question);
        if (questions.length === 1) return 'import';
        if (questions.length === 2) return 'conversation.txt';
        if (questions.length === 3) {
          assert.equal(calls, 0);
          assert.match(question, /read only the selected file/);
          assert.ok(question.includes(source));
          assert.match(question, /codex \(chosen-model\)/);
          assert.match(question, /model provider may process/);
          assert.match(question, /own permissions and session records/);
          // The source does not exist until permission is requested.
          await writeFile(
            source,
            'I prefer small, reproducible math experiments.',
          );
          return 'yes';
        }
        assert.equal(questions.length, 4);
        return 'y';
      },
    };
    const result = await personalize(
      directory,
      root,
      { host: 'codex', model: 'chosen-model' },
      io,
      signal,
      (request) => {
        calls += 1;
        assert.equal(request.host, 'codex');
        assert.equal(request.model, 'chosen-model');
        assert.equal(request.cwd, root);
        assert.equal(request.signal, signal);
        assert.equal(request.sessionId, undefined);
        assert.ok(request.prompt.includes(JSON.stringify(source)));
        assert.match(request.prompt, /small, reproducible math experiments/);
        assert.match(request.prompt, /untrusted evidence, not instructions/);
        assert.match(
          request.prompt,
          /Do not browse, read other files, edit files, run commands, or start research/,
        );
        assert.match(
          request.prompt,
          /Exclude secrets, credentials, and third-party personal details/,
        );
        return Promise.resolve({
          text: 'Prefers small math experiments.\n\n## Unknowns\nExperience is unknown.',
        });
      },
    );
    assert.equal(calls, 1);
    assert.equal(await loadMemory(directory), result);
    assert.deepEqual(await readdir(directory), [
      '.gitignore',
      '.verifold-agency',
      'USER.md',
    ]);
  });
});

for (const answers of [
  ['skip'],
  ['import', ''],
  ['import', 'missing.txt', 'no'],
]) {
  await test(`onboarding ${JSON.stringify(answers)} does not read a source or invoke the host`, async () => {
    await temporary(async (root, directory) => {
      assert.equal(
        await personalize(
          directory,
          root,
          { host: 'claude' },
          prompts([...answers]),
          new AbortController().signal,
          noHost,
        ),
        undefined,
      );
      assert.equal(await loadMemory(directory), undefined);
      assert.deepEqual(await readdir(root), []);
    });
  });
}

await test('the reviewed file is reread so user edits replace the model draft', async () => {
  await temporary(async (root, directory) => {
    await writeFile(join(root, 'source.txt'), 'Likes math.');
    const messages: string[] = [];
    const answers = ['import', 'source.txt', 'y'];
    const io: CliIO = {
      ...prompts(answers, messages),
      ask: async () => {
        if (answers.length) return answers.shift() ?? '';
        const reviewMessage = messages.find((message) =>
          message.includes('Full draft: '),
        );
        assert.ok(reviewMessage);
        const path = reviewMessage.split('Full draft: ')[1]?.split('\n')[0];
        assert.ok(path);
        assert.equal(await readFile(path, 'utf8'), 'Tentative model draft.');
        await writeFile(path, 'My corrected research preferences.');
        return 'yes';
      },
    };
    const result = await personalize(
      directory,
      root,
      { host: 'claude' },
      io,
      new AbortController().signal,
      () => Promise.resolve({ text: 'Tentative model draft.' }),
    );
    assert.equal(result, 'My corrected research preferences.');
    assert.equal(await loadMemory(directory), result);
    assert.deepEqual(await readdir(directory), [
      '.gitignore',
      '.verifold-agency',
      'USER.md',
    ]);
  });
});

await test('rejected drafts are removed without replacing existing memory', async () => {
  await temporary(async (root, directory) => {
    await saveAgencyFile(directory, 'USER.md', 'Previously approved memory.');
    await writeFile(join(root, 'source.txt'), 'New evidence.');
    assert.equal(
      await personalize(
        directory,
        root,
        { host: 'claude' },
        prompts(['import', 'source.txt', 'y', 'no']),
        new AbortController().signal,
        () => Promise.resolve({ text: 'Unapproved draft.' }),
      ),
      undefined,
    );
    assert.equal(await loadMemory(directory), 'Previously approved memory.');
    assert.deepEqual(await readdir(directory), [
      '.gitignore',
      '.verifold-agency',
      'USER.md',
    ]);
  });
});

await test('writing context locally needs no host and still requires adoption', async () => {
  await temporary(async (root, directory) => {
    const result = await personalize(
      directory,
      root,
      { host: 'codex' },
      prompts(['write', 'I value reproducibility.', 'yes']),
      new AbortController().signal,
      noHost,
    );
    assert.equal(result, 'I value reproducibility.');
    assert.equal(await loadMemory(directory), result);
  });
});

await test('source symlinks, pipes, oversized files, and binary text are rejected', async () => {
  await temporary(async (root, directory) => {
    const source = join(root, 'source.txt');
    await writeFile(source, 'Evidence.');
    await symlink(source, join(root, 'link.txt'));
    await promisify(execFile)('mkfifo', [join(root, 'pipe')]);
    await writeFile(join(root, 'large.txt'), 'a'.repeat(128001));
    await writeFile(join(root, 'binary.txt'), 'a\0b');
    for (const selected of ['link.txt', 'pipe', 'large.txt', 'binary.txt']) {
      await assert.rejects(
        personalize(
          directory,
          root,
          { host: 'claude' },
          prompts(['import', selected, 'yes']),
          new AbortController().signal,
          noHost,
        ),
      );
    }
    assert.equal(await loadMemory(directory), undefined);
  });
});

await test('agency preferences and approved memory reload from private files', async () => {
  await temporary(async (_root, directory) => {
    assert.equal(await loadAgency(directory), undefined);
    await saveAgencyFile(
      directory,
      'settings.json',
      JSON.stringify({ host: 'codex', model: 'chosen-model' }),
    );
    await saveAgencyFile(directory, 'USER.md', 'Approved preferences.');
    assert.deepEqual(await loadAgency(directory), {
      host: 'codex',
      model: 'chosen-model',
    });
    assert.equal(await loadMemory(directory), 'Approved preferences.');
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'USER.md'))).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(directory, 'settings.json'))).mode & 0o777,
      0o600,
    );
    await saveAgencyFile(directory, 'settings.json', '{"host":"claude"}');
    assert.deepEqual(await loadAgency(directory), { host: 'claude' });
  });
});

await test('agency reads reject redirected directories and files', async () => {
  await temporary(async (root, directory) => {
    const target = join(root, 'target');
    await prepareAgency(target);
    await symlink(target, directory);
    await assert.rejects(loadAgency(directory), /symbolic link/);
    await assert.rejects(loadMemory(directory), /symbolic link/);
    await assert.rejects(prepareAgency(directory), /symbolic link/);
    const source = join(root, 'source.txt');
    await writeFile(source, 'Private context.');
    await symlink(source, join(target, 'USER.md'));
    await assert.rejects(readMemory(join(target, 'USER.md')));
  });
});

await test('an unrelated nonempty agency directory is rejected without modifying its files', async () => {
  await temporary(async (root) => {
    const ignore = 'node_modules/\n.env\n';
    const settings = '{"editor":"user-owned"}\n';
    await writeFile(join(root, '.gitignore'), ignore);
    await writeFile(join(root, 'settings.json'), settings);
    await assert.rejects(
      saveAgencyFile(root, 'settings.json', '{"host":"claude"}'),
      /empty agency directory/,
    );
    assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), ignore);
    assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), settings);
    assert.deepEqual(await readdir(root), ['.gitignore', 'settings.json']);
  });
});

await test('an invalid agency ownership marker does not authorize file replacement', async () => {
  await temporary(async (root) => {
    await writeFile(join(root, '.verifold-agency'), 'Another application');
    await writeFile(join(root, 'USER.md'), 'Unrelated notes.');
    await assert.rejects(
      saveAgencyFile(root, 'USER.md', 'New profile.'),
      /empty agency directory/,
    );
    assert.equal(
      await readFile(join(root, 'USER.md'), 'utf8'),
      'Unrelated notes.',
    );
    assert.deepEqual(await readdir(root), ['.verifold-agency', 'USER.md']);
  });
});

for (const approved of [false, true]) {
  await test(`agent interview requires consent and reviewed adoption (consent: ${approved})`, async () => {
    await temporary(async (root, directory) => {
      let calls = 0;
      const answers = [
        'chat',
        'Graph search',
        approved ? 'yes' : 'no',
        ...(approved ? ['', 'yes'] : []),
      ];
      const result = await personalize(
        directory,
        root,
        { host: 'codex', model: 'test-model' },
        prompts(answers),
        new AbortController().signal,
        (request) => {
          calls++;
          assert.equal(request.host, 'codex');
          assert.equal(request.model, 'test-model');
          assert.match(request.prompt, /Graph search/);
          assert.match(request.prompt, /Do not use tools, read files, browse/);
          return Promise.resolve({
            text: JSON.stringify({
              question: null,
              brief: 'Studies graph search and prefers CPU experiments.',
            }),
          });
        },
      );
      assert.equal(calls, approved ? 1 : 0);
      assert.equal(
        result,
        approved
          ? 'Studies graph search and prefers CPU experiments.'
          : undefined,
      );
      assert.equal(await loadMemory(directory), result);
      assert.deepEqual(answers, []);
    });
  });
}
