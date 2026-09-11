import test from 'node:test';
import assert from 'node:assert/strict';
import { choose, withActivity } from '../src/cli/choices.ts';
import type { CliIO } from '../src/cli/commands.ts';

const choices = [
  {
    value: 'claude',
    label: 'Claude Code',
    description: 'Existing Claude login',
  },
  { value: 'codex', label: 'Codex', description: 'Existing Codex login' },
];
await test('numbered menus retry invalid input and preserve a remembered default', async () => {
  const answers = ['typo', '2', ''];
  const messages: string[] = [];
  const io: CliIO = {
    interactive: true,
    ask: (question) => {
      assert.match(question, /1\. Claude Code/);
      return Promise.resolve(answers.shift() ?? '');
    },
    out: () => {},
    progress: (message) => {
      messages.push(message);
    },
  };
  assert.equal(await choose(io, 'Harness', choices, 'claude'), 'codex');
  assert.equal(await choose(io, 'Harness', choices, 'codex'), 'codex');
  assert.deepEqual(messages, ['Choose a listed number or name.']);
});
await test('rich menu receives choices and default without a text prompt', async () => {
  const io: CliIO = {
    interactive: true,
    out: () => {},
    ask: () => {
      throw new Error('Unexpected text prompt');
    },
    select: (question, options, initial) => {
      assert.equal(question, 'Harness');
      assert.deepEqual(options, choices);
      assert.equal(initial, 'codex');
      return Promise.resolve('claude');
    },
  };
  assert.equal(await choose(io, 'Harness', choices, 'codex'), 'claude');
});
await test('activity preserves operation results and failures with or without presentation', async () => {
  const io: CliIO = {
    interactive: false,
    out: () => {},
    ask: () => Promise.resolve(''),
  };
  const failure = new Error('Host failed');
  for (const presenter of [
    io,
    {
      ...io,
      busy: <T>(_label: string, work: () => Promise<T>): Promise<T> => work(),
    },
  ]) {
    assert.equal(
      await withActivity(presenter, 'Working', () => Promise.resolve(42)),
      42,
    );
    await assert.rejects(
      withActivity(presenter, 'Working', () => Promise.reject(failure)),
      (error) => error === failure,
    );
  }
});
