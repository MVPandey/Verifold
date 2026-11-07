import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError, createApi } from '../src/api/client.ts';
import { parseChange } from '../src/api/events.ts';
import { takeToken } from '../src/api/token.ts';

interface Call {
  readonly input: string;
  readonly init: RequestInit;
}

function serverThatAnswers(
  status: number,
  body: string,
): { calls: Call[]; fetcher: (input: string, init: RequestInit) => Promise<Response> } {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(new Response(body, { status }));
    },
  };
}

describe('the API client', () => {
  it('sends the token and JSON, and returns the parsed answer', async () => {
    const server = serverThatAnswers(200, '{"folder": "~/code/sort-bench"}');
    const api = createApi('secret', server.fetcher);

    await api.setTime(30);
    const setup = await api.setup();

    assert.equal(setup.folder, '~/code/sort-bench');
    const [time, read] = server.calls;
    assert.equal(time?.input, '/api/time');
    assert.equal(time?.init.method, 'POST');
    assert.equal(time?.init.body, '{"minutes":30}');
    assert.deepEqual(time?.init.headers, {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    });
    assert.equal(read?.init.method, 'GET');
  });

  it('turns a refusal into an error with the server reason', async () => {
    const refusals = [
      [409, '{"detail": "This folder has a lab already."}', 'This folder has a lab already.'],
      [422, '{"detail": [{"msg": "Field required"}]}', 'Field required'],
      [500, 'Internal Server Error', 'The server refused the request (500).'],
    ] as const;
    for (const [status, body, reason] of refusals) {
      const api = createApi('secret', serverThatAnswers(status, body).fetcher);
      await assert.rejects(api.lab(), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.deepEqual([error.status, error.message], [status, reason]);
        return true;
      });
    }
  });

  it('escapes thread IDs in the path', async () => {
    const server = serverThatAnswers(200, '{}');
    await createApi('secret', server.fetcher).thread('t-1/../../x');
    assert.equal(server.calls[0]?.input, '/api/threads/t-1%2F..%2F..%2Fx');
  });
});

describe('the token', () => {
  it('comes from the link once, and from the tab after that', () => {
    const items = new Map<string, string>();
    const store = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };

    assert.equal(takeToken('#/', store), null);
    assert.equal(takeToken('#token=abc', store), 'abc');
    assert.equal(takeToken('#/needs', store), 'abc');
  });
});

describe('the event stream', () => {
  it('reads the change in each event, and ignores anything else', () => {
    assert.deepEqual(parseChange('{"seq": 4, "activity": 2}'), { seq: 4, activity: 2 });
    assert.deepEqual(['', 'nope', '{"seq": "4", "activity": 2}', '[]', 7].map(parseChange), [
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});
