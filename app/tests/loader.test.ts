import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/api/client.ts';
import type { Api } from '../src/api/client.ts';
import type { LabView } from '../src/api/types.ts';
import { EMPTY, LOST, createLoader } from '../src/ui/loader.ts';
import type { LabData } from '../src/ui/loader.ts';
import { DEFAULTS, labView } from './fixtures.ts';

/** A server whose lab view answers only when the test says so, and whose other views answer at once. */
function slowServer(): {
  api: Api;
  calls: string[];
  answerLab: (lab: LabView) => void;
  failNext: () => void;
} {
  const calls: string[] = [];
  const waiting: ((lab: LabView) => void)[] = [];
  let fail = false;
  const answer = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    if (fail) {
      fail = false;
      return Promise.reject(new ApiError(0, "Can't reach verifold."));
    }
    return Promise.resolve(value);
  };
  const api: Api = {
    setup: () =>
      answer('setup', {
        folder: '~/lab',
        harnesses: [],
        question: 'Q?',
        defaults: DEFAULTS,
        defaults_from: null,
      }),
    lab: () => {
      calls.push('lab');
      return new Promise((resolve) => waiting.push(resolve));
    },
    threads: () => answer('threads', []),
    needs: () => answer('needs', []),
    report: () => answer('report', null),
    start: () => Promise.reject(new Error('unused')),
    thread: () => Promise.reject(new Error('unused')),
    post: () => Promise.reject(new Error('unused')),
    rerun: () => Promise.reject(new Error('unused')),
    setTime: () => Promise.reject(new Error('unused')),
    settings: () => Promise.reject(new Error('unused')),
    changeSetting: () => Promise.reject(new Error('unused')),
  };
  return {
    api,
    calls,
    answerLab: (lab) => waiting.shift()?.(lab),
    failNext: () => {
      fail = true;
    },
  };
}

function store(): { data: () => LabData; apply: (update: (old: LabData) => LabData) => void } {
  let data = EMPTY;
  return {
    data: () => data,
    apply: (update) => {
      data = update(data);
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const working = labView({ question: 'working' });
const stopped = labView({ question: 'stopped' });

describe('the loader', () => {
  it('reads the lab view again when the activity changes during a full read', async () => {
    const server = slowServer();
    const state = store();
    const loader = createLoader(server.api, state.apply);

    loader.full();
    await settle();
    loader.activity();
    server.answerLab(working);
    await settle();
    server.answerLab(stopped);
    await settle();

    assert.deepEqual(server.calls, ['setup', 'lab', 'threads', 'needs', 'report', 'lab']);
    assert.equal(state.data().lab?.question, 'stopped');
  });

  it('makes every read a full one after a full read fails', async () => {
    const server = slowServer();
    const state = store();
    const loader = createLoader(server.api, state.apply);

    server.failNext();
    loader.full();
    await settle();
    assert.equal(loader.stale(), true);
    assert.equal(state.data().error, "Can't reach verifold.");

    loader.activity();
    await settle();
    server.answerLab(working);
    await settle();

    assert.deepEqual(server.calls, ['setup', 'setup', 'lab', 'threads', 'needs', 'report']);
    assert.equal(loader.stale(), false);
    assert.equal(state.data().error, null);
  });

  it('keeps saying the connection is lost until the stream is back', async () => {
    const server = slowServer();
    const state = store();
    const loader = createLoader(server.api, state.apply);

    loader.lose();
    server.failNext();
    loader.full();
    await settle();
    assert.equal(state.data().error, LOST);

    loader.back();
    await settle();
    server.answerLab(working);
    await settle();
    assert.equal(state.data().error, null);
  });
});
