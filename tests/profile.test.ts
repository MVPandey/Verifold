import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile } from '../src/domain/profile.ts';
import { loadProfile, saveProfile } from '../src/adapters/profile-storage.ts';
import { escapeHtml } from '../src/ui/dom.ts';
const input = {
  name: ' Manav ',
  interests: ['ML', 'ML'],
  scholar: '',
  github: 'https://github.com/MVPandey',
  session: '/local/reference',
};
await test('profile trims input, deduplicates interests, and freezes owned arrays', () => {
  const profile = parseProfile(input);
  assert.equal(profile.name, 'Manav');
  assert.deepEqual(profile.interests, ['ML']);
  assert.ok(Object.isFrozen(profile.interests));
});
await test('untrusted profile and unsafe account URLs fail validation', () => {
  for (const value of [
    null,
    {},
    { ...input, interests: [] },
    { ...input, github: 'javascript:alert(1)' },
    { ...input, github: 'https://github.com.evil.test' },
    { ...input, github: 'https://user:pass@github.com' },
  ])
    assert.throws(() => parseProfile(value));
});
await test('storage round trip validates and surfaces malformed or unavailable storage', () => {
  let saved: string | null = null;
  const storage = {
    getItem: (): string | null => saved,
    setItem: (_key: string, value: string): void => {
      saved = value;
    },
  };
  assert.equal(loadProfile(storage), null);
  saveProfile(storage, parseProfile(input));
  assert.equal(loadProfile(storage)?.name, 'Manav');
  saved = '{';
  assert.throws(() => loadProfile(storage));
  assert.throws(
    () =>
      saveProfile(
        {
          ...storage,
          setItem: () => {
            throw new Error('Quota exceeded');
          },
        },
        parseProfile(input),
      ),
    /Quota exceeded/,
  );
});
await test('rendered profile text cannot inject HTML', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
  );
});
