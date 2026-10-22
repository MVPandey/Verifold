import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  WakeLoop,
  type QueuedEvent,
  type WakeEvent,
  type WakeRecord,
} from '../src/core/agent-loop.ts';
import { until } from './wait.ts';

type Record = WakeRecord<WakeEvent> & { readonly stopped: boolean };

/** An agent whose record lives in memory. `fail` makes the next send throw. */
function agent(start: Partial<Record> = {}): {
  loop: WakeLoop<WakeEvent, Record>;
  record: () => Record;
  sent: (readonly QueuedEvent<WakeEvent>[])[];
  failNext: () => void;
  /** Sends tried, also the ones that threw. */
  attempts: () => number;
} {
  let record: Record = {
    cursor: 0,
    wakeups: [],
    events: [],
    stopped: false,
    ...start,
  };
  const sent: (readonly QueuedEvent<WakeEvent>[])[] = [];
  let fail = false;
  let attempts = 0;
  const loop = new WakeLoop<WakeEvent, Record>(
    {
      record: () => (record.stopped ? null : record),
      save: (next) => {
        record = next;
        return Promise.resolve();
      },
      ready: () => true,
      send: (events) => {
        attempts += 1;
        if (fail) {
          fail = false;
          throw new Error('The session is busy.');
        }
        sent.push(events);
      },
    },
    { wakeupsPerHour: 2, digest: 3, events: 10, debounceMs: 30 },
  );
  return {
    loop,
    record: () => record,
    sent,
    failNext: () => {
      fail = true;
    },
    attempts: () => attempts,
  };
}

await test('the wake loop joins close events, caps a digest, and keeps its record bounded', async () => {
  const { loop, record, sent } = agent();
  loop.add([{ kind: 'post', text: 'one\ntwo' }]);
  loop.add([
    { kind: 'post', text: 'three' },
    { kind: 'post', text: 'four' },
  ]);
  await until(() => sent.length === 1);
  await loop.close();
  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0]?.map((event) => event.text),
    ['one two', 'three', 'four'],
  );
  assert.equal(record().cursor, 3);
  // The record keeps the newest events only.
  for (let index = 0; index < 12; index += 1)
    loop.add([{ kind: 'post', text: `${index}` }], 10_000);
  await loop.close();
  loop.cancel();
  assert.equal(record().events.length, 10);
  assert.equal(record().events.at(-1)?.seq, 15);
});

await test('a failed send keeps the events for the next wakeup, and the hourly limit holds the rest', async () => {
  const { loop, record, sent, failNext, attempts } = agent();
  failNext();
  loop.add([{ kind: 'person', text: 'Look at seed 2.' }], 0);
  await until(() => attempts() === 1);
  await loop.close();
  assert.equal(sent.length, 0);
  assert.equal(record().cursor, 0);
  assert.deepEqual(record().wakeups, []);
  loop.schedule(0);
  await until(() => sent.length === 1);
  await loop.close();
  assert.equal(sent.length, 1);
  // Two wakeups an hour: the third waits, and the loop says until when.
  loop.add([{ kind: 'post', text: 'b' }], 0);
  await until(() => sent.length === 2);
  loop.add([{ kind: 'post', text: 'c' }], 0);
  await until(() => loop.limitedUntil !== null);
  await loop.close();
  assert.equal(sent.length, 2);
  assert.ok(loop.limitedUntil && Date.parse(loop.limitedUntil) > Date.now());
  loop.cancel(true);
  assert.equal(loop.limitedUntil, null);
});

await test('events of a turn whose read failed come once more, marked again', async () => {
  const { loop, record, sent } = agent();
  loop.add([{ kind: 'post', text: 'p-3' }], 0);
  await until(() => sent.length === 1);
  loop.readFailed();
  loop.turnEnded();
  await until(() => sent.length === 2);
  loop.readFailed();
  loop.turnEnded();
  // close() waits for the loop's queue, so an event added again would show here.
  await loop.close();
  assert.equal(
    record().events.filter((event) => event.seq > record().cursor).length,
    0,
  );
  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent[1]?.map((event) => [event.text, event.again]),
    [['p-3', true]],
  );
  // An event comes again only once.
  assert.equal(record().events.length, 2);
});

await test('a stopped agent takes no events', async () => {
  const { loop, record } = agent({ stopped: true });
  loop.add([{ kind: 'post', text: 'p-1' }], 0);
  await delay(20);
  await loop.close();
  assert.deepEqual(record().events, []);
});
