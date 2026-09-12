import test from 'node:test';
import assert from 'node:assert/strict';
import { researchInterview } from '../src/cli/onboarding.ts';
import type { CliIO } from '../src/cli/commands.ts';
import type { HarnessRequest } from '../src/cli/harness.ts';

const signal = (): AbortSignal => new AbortController().signal;

await test('accepted project context enables native clarification tools explicitly', async () => {
  const result = await researchInterview(
    'Graphs',
    'Reviewed project context',
    { host: 'codex' },
    '.',
    { interactive: false, out: () => {}, ask: () => Promise.resolve('') },
    signal(),
    (request) => {
      assert.match(request.prompt, /Use your native tools, web search/);
      assert.doesNotMatch(request.prompt, /Do not use tools/);
      assert.match(request.prompt, /Do not edit files/);
      return Promise.resolve({
        text: '# Research brief\n\nA bounded graph question.',
      });
    },
    'project',
  );
  assert.match(result, /bounded graph question/);
});
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
        assert.match(request.prompt, /Write the research brief now/);
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

await test('Markdown and missing legacy brief fields do not fail onboarding', async () => {
  for (const response of [
    'What would you like to learn about J-Lens/SHAPley?',
    '{"question":"What would you like to test?"}',
  ]) {
    let calls = 0;
    const result = await researchInterview(
      'J-Lens/SHAPley',
      undefined,
      { host: 'claude' },
      '.',
      io(['/finish', '']),
      signal(),
      () =>
        Promise.resolve({
          text:
            ++calls === 1
              ? response
              : '# Research brief\n\nInvestigate attribution stability.',
        }),
    );
    assert.match(result, /attribution stability/);
  }
});

await test('failed and oversized replies offer local recovery without losing the topic', async () => {
  for (const response of ['', 'é'.repeat(6000)]) {
    const result = await researchInterview(
      'J-Lens/SHAPley',
      undefined,
      { host: 'claude' },
      '.',
      io(['local', '']),
      signal(),
      () => Promise.resolve({ text: response }),
    );
    assert.match(result, /J-Lens\/SHAPley/);
    assert.match(result, /no agent review/);
  }
});

await test('an explicit retry keeps previous answers and uses Markdown', async () => {
  let calls = 0;
  const result = await researchInterview(
    'Graphs',
    undefined,
    { host: 'claude' },
    '.',
    io(['retry', '']),
    signal(),
    (request) => {
      assert.match(request.prompt, /Graphs/);
      if (++calls === 1) throw new Error('Private provider diagnostics');
      return Promise.resolve({
        text: '# Research brief\n\nUse controlled graphs.',
      });
    },
  );
  assert.equal(calls, 2);
  assert.match(result, /controlled graphs/);
});

await test('noninteractive onboarding returns a brief without asking questions', async () => {
  const result = await researchInterview(
    'Graphs',
    undefined,
    { host: 'codex' },
    '.',
    { ...io([]), interactive: false },
    signal(),
    (request) => {
      assert.match(request.prompt, /Write the research brief now/);
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

await test('local recovery preserves user answers when an agent reply contains long prose', async () => {
  let calls = 0;
  const result = await researchInterview(
    'Graphs',
    undefined,
    { host: 'claude' },
    '.',
    io(['Use deterministic CPU experiments.', 'local', '']),
    signal(),
    () =>
      Promise.resolve({
        text: ++calls === 1 ? 'Long model explanation.\n'.repeat(300) : '',
      }),
  );
  assert.match(result, /Use deterministic CPU experiments/);
  assert.ok(Buffer.byteLength(result) < 2000);
});

await test('local recovery retains supplied project evidence before a long conversation', async () => {
  const evidence =
    'Study deterministic graph matching. The supplied project uses a CPU baseline.';
  let calls = 0;
  const result = await researchInterview(
    'Help choose a direction from this project.',
    evidence,
    { host: 'claude' },
    '.',
    io(['More detail. '.repeat(300), 'local', '']),
    signal(),
    () =>
      ++calls === 1
        ? Promise.resolve({ text: 'What constraints apply?' })
        : Promise.reject(new Error('Harness unavailable')),
  );
  assert.ok(result.includes(evidence));
  assert.match(result, /no agent review was completed/);
  assert.ok(Buffer.byteLength(result) <= 12000);
});
