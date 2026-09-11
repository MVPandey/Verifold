import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth, wrapText } from '../src/cli/terminal-layout.ts';

await test('terminal widths count graphemes and common wide characters', () => {
  assert.equal(visibleWidth('Verifold'), 8);
  assert.equal(visibleWidth('e\u0301'), 1);
  assert.equal(visibleWidth('研究'), 4);
  assert.equal(visibleWidth('🧑🏽‍🔬'), 2);
  assert.equal(visibleWidth('🇺🇸'), 2);
  assert.equal(visibleWidth('1️⃣'), 2);
  assert.equal(visibleWidth('a\nlonger'), 6);
  assert.equal(visibleWidth(''), 0);
});

await test('wrapping removes terminal commands and keeps explicit paragraphs', () => {
  assert.deepEqual(wrapText('  one  two three\r\n\r\nfour\n', 7), [
    'one two',
    'three',
    '',
    'four',
    '',
  ]);
  const unsafe = '\u001b[31mhello\u001b[0m\u001b]0;hidden\u0007\u0000';
  assert.deepEqual(wrapText(unsafe, 12), ['hello']);
  assert.equal(visibleWidth(unsafe), 5);
  assert.deepEqual(wrapText('left\u202eright', 20), ['leftright']);
});

await test('long paths and Unicode remain bounded at narrow terminal widths', () => {
  assert.deepEqual(wrapText('/long/path/name', 5), ['/long', '/path', '/name']);
  assert.deepEqual(wrapText('研究 e\u0301🧑🏽‍🔬', 3), ['研', '究', 'e\u0301🧑🏽‍🔬']);
  assert.deepEqual(wrapText('研究', 1), ['�', '�']);
  const input =
    'A long /Users/researcher/documents/USER.md path. 研究 🧑🏽‍🔬 e\u0301';
  for (const width of [1, 2, 3, 20, 40, 76])
    for (const line of wrapText(input, width))
      assert.ok(visibleWidth(line) <= width, JSON.stringify({ width, line }));
});

await test('wrapping rejects invalid widths and accepts empty input', () => {
  for (const width of [0, -1, 1.5, Infinity, NaN])
    assert.throws(() => wrapText('text', width), RangeError);
  assert.deepEqual(wrapText('', 10), ['']);
});
