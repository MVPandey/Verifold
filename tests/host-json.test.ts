import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseHostJson,
  parseResearchPlan,
} from '../src/cli/research-contracts.ts';

await test('host JSON accepts raw JSON without interpreting string content as fences', () => {
  assert.deepEqual(parseHostJson(' \n{"text":"```json"}\n '), {
    text: '```json',
  });
});

for (const newline of ['\n', '\r\n']) {
  for (const language of ['', 'json']) {
    await test(`host JSON accepts ${language || 'untyped'} fences with ${JSON.stringify(newline)} and trailing commentary`, () => {
      const block = [
        `\`\`\`${language}`,
        '{"scope":"a small pilot"}',
        '```',
      ].join(newline);
      assert.deepEqual(parseHostJson(block), { scope: 'a small pilot' });
      assert.deepEqual(
        parseHostJson(
          `${block}${newline}${newline}Plan only — no searches have been run.`,
        ),
        { scope: 'a small pilot' },
      );
    });
  }
}

const invalid = [
  'Here is a plan:\n```json\n{}\n```',
  '```javascript\n{}\n```',
  '```json\n{}',
  '```json\n{}\n``` extra',
  '```json\nnot JSON\n```\nPlan only.',
  '```json\n{}\n```\n```json\n{}\n```',
  '```json\n{}\n```\n~~~json\n{}\n~~~',
  '```json\n{}\n```\n{"other":"result"}',
  '```json\n{}\n```\n[{"other":"result"}]',
  '```json\n{"text":"```"}\n```',
  '{}\nPlan only.',
];
for (const input of invalid) {
  await test(`host JSON rejects an invalid or ambiguous envelope: ${JSON.stringify(input)}`, () => {
    assert.throws(() => parseHostJson(input));
  });
}

await test('host JSON bounds input before parsing', () => {
  assert.throws(
    () => parseHostJson(' '.repeat(2 * 1024 * 1024 + 1)),
    /exceeds/,
  );
});

await test('accepting trailing commentary does not bypass research plan validation', () => {
  const parsed = parseHostJson(
    '```json\n{"scope":"pilot","personas":[]}\n```\nPlan only.',
  );
  assert.throws(() => parseResearchPlan(parsed), /2 to 5 personas/);
});
