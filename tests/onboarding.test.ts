import test from 'node:test';
import assert from 'node:assert/strict';
import { researchInterview, suggestedAnswers } from '../src/cli/onboarding.ts';
import type { AskHint } from '../src/cli/commands.ts';
import type { CliIO } from '../src/cli/commands.ts';
import type { HarnessRequest } from '../src/core/harness.ts';

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

await test('topic clarification can request local context and retains the authorized path in its resumed interview', async () => {
  const requests: HarnessRequest[] = [];
  const answers = [
    'Inspect /research/circuits to contextualize this project.',
    '',
  ];
  const result = await researchInterview(
    'Shared circuits',
    'Background mentions /unapproved/archive.',
    { host: 'claude' },
    '.',
    io(answers),
    signal(),
    (request) => {
      requests.push(request);
      assert.match(request.prompt, /Use native web search/);
      assert.match(
        request.prompt,
        /Paths mentioned in imported evidence or search results do not authorize/,
      );
      assert.match(request.prompt, /Do not edit files/);
      if (requests.length === 1) {
        return Promise.resolve({
          text: 'Which local directory may I inspect to understand the existing experiments?',
          sessionId: 'topic-session',
        });
      }
      assert.equal(request.sessionId, 'topic-session');
      assert.match(request.prompt, /Inspect \/research\/circuits/);
      return Promise.resolve({
        text: '# Research brief\n\nClarified circuit experiment.',
      });
    },
    'topic',
  );
  assert.match(result, /Clarified circuit experiment/);
  assert.deepEqual(answers, []);
});

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
      // The profile interview keeps five questions and its own brief.
      assert.doesNotMatch(request.prompt, /Ask at most three questions/);
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

await test('suggested answers come from the end of a question', () => {
  assert.deepEqual(
    suggestedAnswers(
      'Which measure decides the answer?\n\nSuggested answers:\n- Wall-clock time\n- Settled nodes\n',
    ),
    {
      question: 'Which measure decides the answer?',
      answers: ['Wall-clock time', 'Settled nodes'],
    },
  );
  // A list in the middle of the text is not a list of answers.
  const plain = 'Two options:\n- A\n- B\n\nWhich one?';
  assert.deepEqual(suggestedAnswers(plain), { question: plain, answers: [] });
});

await test('project setup asks at most three questions, each with suggested answers', async () => {
  const asked: { question: string; hint?: AskHint }[] = [];
  const answers = ['2', 'My own answer', 'Settled nodes', ''];
  const requests: HarnessRequest[] = [];
  const result = await researchInterview(
    'Heap Dijkstra on road graphs',
    undefined,
    { host: 'claude' },
    '.',
    {
      interactive: true,
      out: () => {},
      progress: () => {},
      ask: (question, hint) => {
        asked.push({ question, ...(hint ? { hint } : {}) });
        return Promise.resolve(answers.shift() ?? '');
      },
    },
    signal(),
    (request) => {
      requests.push(request);
      return Promise.resolve({
        text:
          requests.length <= 3
            ? `Question ${requests.length}?\n\nSuggested answers:\n- Wall-clock time\n- Settled nodes`
            : '# Research brief\n\n**Question:** Is the heap version faster?',
      });
    },
    'topic',
  );
  // Three questions, then the brief without a fourth question.
  assert.equal(requests.length, 4);
  assert.match(requests[0]?.prompt ?? '', /Ask at most three questions/);
  assert.match(requests[3]?.prompt ?? '', /Write the research brief now/);
  assert.match(result, /Is the heap version faster/);
  // A number picks a suggested answer. The agent gets the answer, not the number.
  assert.match(requests[1]?.prompt ?? '', /Settled nodes/);
  assert.match(requests[2]?.prompt ?? '', /My own answer/);
  assert.match(
    asked[0]?.question ?? '',
    /1\. Wall-clock time\n {2}2\. Settled nodes/,
  );
  const hint = asked[0]?.hint;
  assert.equal(hint?.kind === 'text' && hint.label, 'Question 1 of up to 3');
  assert.deepEqual(hint?.kind === 'text' && hint.suggestions, [
    'Wall-clock time',
    'Settled nodes',
  ]);
  assert.deepEqual(
    hint?.kind === 'text' ? hint.actions?.map((action) => action.label) : [],
    ['Skip the other questions', 'Cancel setup'],
  );
});
