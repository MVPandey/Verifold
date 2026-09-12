import test from 'node:test';
import assert from 'node:assert/strict';
import { researchInterview } from '../src/cli/onboarding.ts';
import type { CliIO } from '../src/cli/commands.ts';
import type { HarnessRequest } from '../src/cli/harness.ts';

const signal = (): AbortSignal => new AbortController().signal;
function io(answers: string[]): CliIO {
  return {
    interactive: true,
    out: () => {},
    progress: () => {},
    ask: () => {
      const answer = answers.shift();
      assert.notEqual(answer, undefined, 'Unexpected question');
      return Promise.resolve(answer ?? '');
    },
  };
}

await test('a reviewed brief can be refined without accepting the first model proposal', async () => {
  const requests: HarnessRequest[] = [];
  const result = await researchInterview(
    'Graphs',
    'Known background',
    { host: 'codex' },
    '.',
    io(['Focus on CPU', '']),
    signal(),
    (request) => {
      requests.push(request);
      return Promise.resolve({
        text: JSON.stringify({
          question: null,
          brief: requests.length === 1 ? 'GPU proposal' : 'CPU proposal',
        }),
      });
    },
  );
  assert.equal(result, 'CPU proposal');
  assert.match(requests[1]?.prompt ?? '', /Focus on CPU/);
  assert.match(requests[1]?.prompt ?? '', /GPU proposal/);
  assert.match(requests[0]?.prompt ?? '', /Known background/);
});

await test('follow-ups are bounded and /finish requests a final brief', async () => {
  let calls = 0;
  const result = await researchInterview(
    'Graphs',
    undefined,
    { host: 'claude' },
    '.',
    io(['/finish', '']),
    signal(),
    (request) => {
      calls++;
      if (calls === 2)
        assert.match(request.prompt, /Return question: null now/);
      return Promise.resolve({
        text: JSON.stringify({
          question: calls === 1 ? 'Why?' : null,
          brief: 'Unknowns remain explicit.',
        }),
      });
    },
  );
  assert.equal(calls, 2);
  assert.equal(result, 'Unknowns remain explicit.');
});

for (const value of [
  'not json',
  '{"brief":"ok"}',
  JSON.stringify({ question: null, brief: 'é'.repeat(6000) }),
  JSON.stringify({ question: [], brief: 'ok' }),
]) {
  await test('invalid onboarding output is rejected before review', async () => {
    await assert.rejects(
      researchInterview(
        'Graphs',
        undefined,
        { host: 'codex' },
        '.',
        io([]),
        signal(),
        () => Promise.resolve({ text: value }),
      ),
    );
  });
}

await test('noninteractive onboarding returns a brief without asking questions', async () => {
  const result = await researchInterview(
    'Graphs',
    undefined,
    { host: 'codex' },
    '.',
    { ...io([]), interactive: false },
    signal(),
    (request) => {
      assert.match(request.prompt, /Return question: null now/);
      return Promise.resolve({
        text: '{"question":null,"brief":"Unreviewed automation brief; constraints unknown."}',
      });
    },
  );
  assert.match(result, /constraints unknown/);
});

await test('cancellation and declined brief stop onboarding', async () => {
  const host = (): Promise<{ text: string }> =>
    Promise.resolve({ text: '{"question":null,"brief":"Proposal"}' });
  await assert.rejects(
    researchInterview(
      'Graphs',
      undefined,
      { host: 'codex' },
      '.',
      io(['/cancel']),
      signal(),
      host,
    ),
    /cancelled/,
  );
  const controller = new AbortController();
  await assert.rejects(
    researchInterview(
      'Graphs',
      undefined,
      { host: 'codex' },
      '.',
      io([]),
      controller.signal,
      () => {
        controller.abort();
        return host();
      },
    ),
    /abort/i,
  );
});
