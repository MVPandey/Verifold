import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError, NO_CANDIDATES } from '../src/api/client.ts';
import type { Api } from '../src/api/client.ts';
import type { CandidatesView, LabView } from '../src/api/types.ts';
import { EMPTY, LOST, createLoader, inOrder, settled } from '../src/ui/loader.ts';
import type { LabData } from '../src/ui/loader.ts';
import { DEFAULTS, labView, postView, result } from './fixtures.ts';

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
    reading: () => answer('reading', null),
    candidates: () => answer('candidates', NO_CANDIDATES),
    conversation: () =>
      answer('conversation', {
        coordinator: null,
        thread: null,
        waits: [],
        no_reply: [],
        asks: [],
        powers: [],
        deeds: [],
      }),
    desk: () => answer('desk', { desk: null, thread: null, actions: [] }),
    setPower: () => Promise.reject(new Error('unused')),
    answerRequest: () => Promise.reject(new Error('unused')),
    takeMinutesBack: () => Promise.reject(new Error('unused')),
    file: () => Promise.reject(new Error('unused')),
    openFolder: () => Promise.reject(new Error('unused')),
    start: () => Promise.reject(new Error('unused')),
    thread: () => Promise.reject(new Error('unused')),
    post: () => Promise.reject(new Error('unused')),
    vote: () => Promise.reject(new Error('unused')),
    badge: () => Promise.reject(new Error('unused')),
    rerun: () => Promise.reject(new Error('unused')),
    setTime: () => Promise.reject(new Error('unused')),
    setBudget: () => Promise.reject(new Error('unused')),
    setDisk: () => Promise.reject(new Error('unused')),
    reviseQuestion: () => Promise.reject(new Error('unused')),
    addAgents: () => Promise.reject(new Error('unused')),
    addDeliverable: () => Promise.reject(new Error('unused')),
    changeDeliverable: () => Promise.reject(new Error('unused')),
    removeDeliverable: () => Promise.reject(new Error('unused')),
    decideDeliverable: () => Promise.reject(new Error('unused')),
    changeSeat: () => Promise.reject(new Error('unused')),
    changeProfile: () => Promise.reject(new Error('unused')),
    setReviewerSeats: () => Promise.reject(new Error('unused')),
    askOffers: () => Promise.reject(new Error('unused')),
    setCoordinatorSeat: () => Promise.reject(new Error('unused')),
    invite: () => Promise.reject(new Error('unused')),
    inviteAgain: () => Promise.reject(new Error('unused')),
    removeAgent: () => Promise.reject(new Error('unused')),
    startAgain: () => Promise.reject(new Error('unused')),
    settings: () => Promise.reject(new Error('unused')),
    changeSetting: () => Promise.reject(new Error('unused')),
    norms: () => Promise.reject(new Error('unused')),
    saveNorms: () => Promise.reject(new Error('unused')),
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

    assert.deepEqual(server.calls, [
      'setup',
      'lab',
      'threads',
      'needs',
      'report',
      'reading',
      'candidates',
      'conversation',
      'desk',
      'lab',
    ]);
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

    assert.deepEqual(server.calls, [
      'setup',
      'setup',
      'lab',
      'threads',
      'needs',
      'report',
      'reading',
      'candidates',
      'conversation',
      'desk',
    ]);
    assert.equal(loader.stale(), false);
    assert.equal(state.data().error, null);
  });

  it('reads the candidate answers again at every full read', async () => {
    const server = slowServer();
    const state = store();
    const answers = ['Yes, 12x.', 'No: 3x at most.'].map((text, index): CandidatesView => ({
      standing: [
        {
          candidate: postView(result(`p-${index + 2}`, { kind: 'proposal', text }), index + 2),
          to_earlier_question: false,
          builds_on: [],
          results: 0,
          no_blind_rerun: [],
          entry: null,
        },
      ],
      gone: [],
      closes_on: null,
    }));
    const api = {
      ...server.api,
      candidates: () => Promise.resolve(answers.shift() ?? NO_CANDIDATES),
    };
    const loader = createLoader(api, state.apply);

    loader.full();
    await settle();
    server.answerLab(working);
    await settle();
    assert.equal(state.data().candidates.standing[0]?.candidate.post.text, 'Yes, 12x.');

    // A new event on the board causes a full read, and the candidates come with it.
    loader.full();
    await settle();
    server.answerLab(working);
    await settle();
    assert.equal(state.data().candidates.standing[0]?.candidate.post.text, 'No: 3x at most.');
    assert.equal(state.data().version, 2);
  });

  it('shows a thread read that the next read overtakes, and never an older read after a newer one', () => {
    const order = inOrder();
    const [first, second, third] = [order(), order(), order()];

    // The first read answers while the second is on its way: the thread moves on instead of waiting.
    assert.equal(first(true), true);
    // The third answers before the second, so the second is old news.
    assert.equal(third(true), true);
    assert.equal(second(true), false);
    assert.equal(second(false), false);
  });

  it('shows an earlier thread read that succeeds after a later read failed', () => {
    const order = inOrder();
    const [first, second, third] = [order(), order(), order()];

    // The later read fails first, and its error shows.
    assert.equal(second(false), true);
    // The earlier read then succeeds, and the thread shows in place of the error.
    assert.equal(first(true), true);
    // A failure from before a read that has shown says nothing new.
    assert.equal(third(true), true);
    assert.equal(second(false), false);
  });

  it('reads once after a burst of changes, and does not wait for a steady stream of them to stop', async () => {
    let runs = 0;
    const read = settled(
      () => {
        runs += 1;
      },
      30,
      100,
    );
    const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    read.poke();
    read.poke();
    await pause(80);
    assert.equal(runs, 1);

    // A change every 10 ms never leaves 30 ms of quiet, and a read still comes at the latest after 100 ms.
    for (let step = 0; step < 35; step += 1) {
      read.poke();
      await pause(10);
    }
    assert.ok(runs >= 3, `${runs} runs`);

    read.stop();
    const before = runs;
    await pause(60);
    assert.equal(runs, before);
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
