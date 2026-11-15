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

  it('asks for an invitation with a name, or with none', async () => {
    const server = serverThatAnswers(200, '{"agent": "agent-3", "name": "Reader", "text": "URL"}');
    const api = createApi('secret', server.fetcher);

    const invitation = await api.invite({
      name: 'Reader',
      role: 'reads',
      family: 'openai',
      on_call: true,
    });
    await api.invite();
    await api.inviteAgain('agent-3');

    assert.deepEqual(invitation, { agent: 'agent-3', name: 'Reader', text: 'URL' });
    assert.deepEqual(
      server.calls.map((call) => [call.input, call.init.body]),
      [
        ['/api/invitations', '{"name":"Reader","role":"reads","family":"openai","on_call":true}'],
        ['/api/invitations', '{}'],
        ['/api/invitations/agent-3', '{}'],
      ],
    );
  });

  it("changes an agent's seat, and asks the harnesses what they offer", async () => {
    const server = serverThatAnswers(200, '{"agents": []}');
    const api = createApi('secret', server.fetcher);

    await api.changeSeat('agent 2', { on_call: true });
    await api.changeSeat('agent-1', { coordinator: false });
    await api.askOffers();

    assert.deepEqual(
      server.calls.map((call) => [call.input, call.init.body]),
      [
        ['/api/agents/agent%202/seat', '{"on_call":true}'],
        ['/api/agents/agent-1/seat', '{"coordinator":false}'],
        ['/api/offers', '{}'],
      ],
    );
  });

  it('removes an agent with a DELETE, starts one again, and reads a lab from before agents could leave or stop', async () => {
    const lab = '{"agents": [{"agent": {"id": "agent-1"}}]}';
    const server = serverThatAnswers(200, lab);
    const api = createApi('secret', server.fetcher);

    await api.removeAgent('agent 2');
    const read = await api.lab();
    await api.startAgain('agent 2');

    const [removal, , start] = server.calls;
    assert.equal(start?.input, '/api/agents/agent%202/start');
    assert.equal(start?.init.method, 'POST');
    assert.equal(read.agents[0]?.stopped, false);
    assert.equal(removal?.input, '/api/agents/agent%202');
    assert.equal(removal?.init.method, 'DELETE');
    assert.equal(removal?.init.body, undefined);
    assert.equal(read.agents[0]?.left, null);
    assert.equal(read.close_among, 1);
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

  it('sends a revision of the question, and reads a lab from before revisions as a lab without versions', async () => {
    const server = serverThatAnswers(200, '{"question": "Faster?", "agents": []}');
    const api = createApi('secret', server.fetcher);

    const lab = await api.reviseQuestion('Faster on ARM?', 'x86 only so far.');
    const read = await api.lab();

    assert.equal(server.calls[0]?.input, '/api/question');
    assert.equal(
      server.calls[0]?.init.body,
      '{"question":"Faster on ARM?","note":"x86 only so far."}',
    );
    assert.equal(lab.question, 'Faster?');
    assert.deepEqual(read.versions, []);
  });

  it('reads threads from a server from before side threads as threads without members', async () => {
    const summaries =
      '[{"thread": {"id": "t-1", "title": "A", "opened_by": "agent-1"}, "posts": 2}]';
    const threads = await createApi('secret', serverThatAnswers(200, summaries).fetcher).threads();
    const view = '{"thread": {"id": "t-1", "title": "A", "opened_by": "agent-1"}, "posts": []}';
    const thread = await createApi('secret', serverThatAnswers(200, view).fetcher).thread('t-1');
    const side =
      '{"thread": {"id": "t-2", "title": "B", "opened_by": "agent-1"}, "members": ["agent-1"]}';
    const kept = await createApi('secret', serverThatAnswers(200, side).fetcher).thread('t-2');

    assert.deepEqual([threads[0]?.members, thread.members], [[], []]);
    assert.deepEqual(kept.members, ['agent-1']);
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

describe('an unreachable server', () => {
  it('gives an error that says verifold cannot be reached', async () => {
    const api = createApi('secret', () => Promise.reject(new TypeError('Failed to fetch')));
    await assert.rejects(api.lab(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.deepEqual(
        [error.status, error.message],
        [0, "Can't reach verifold. Check that it is still running."],
      );
      return true;
    });
  });
});
