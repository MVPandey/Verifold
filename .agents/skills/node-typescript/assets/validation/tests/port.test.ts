import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePort } from '../src/port.js';

await test('accepts valid ports including both boundaries', () => {
  assert.equal(parsePort('1'), 1);
  assert.equal(parsePort('3000'), 3000);
  assert.equal(parsePort('65535'), 65535);
});

await test('rejects empty, whitespace, fractional, and nonnumeric input', () => {
  for (const raw of ['', ' ', ' 80', '80 ', '3.5', '1e3', 'abc', '-1']) {
    assert.throws(() => parsePort(raw), TypeError);
  }
});

await test('rejects out-of-range and unsafe integer ports', () => {
  for (const raw of ['0', '65536', '999999999999999999999']) {
    assert.throws(() => parsePort(raw), RangeError);
  }
});
