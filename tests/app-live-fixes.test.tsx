import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Brief, BriefLine, Lab, Question } from '../src/protocol/api.ts';
import { lineWords } from '../src/app/brief-view.ts';
import { BriefCard } from '../src/app/components/BriefCard.tsx';
import { ClipToggle, LineWords } from '../src/app/components/LineWords.tsx';
import { Answers } from '../src/app/components/StepInParts.tsx';
import { askedOfYou, rowWaits, waitLine } from '../src/app/waits.ts';
import { ViewContext, type ViewMode } from '../src/app/view-mode.ts';

const now = Date.UTC(2026, 10, 1, 12, 0);
const at = new Date(now - 60_000).toISOString();

const line = (more: Partial<BriefLine> = {}): BriefLine => ({
  kind: 'open',
  at,
  plain: null,
  quotes: [
    { post: 'p-1', text: 'The first post says one thing.' },
    { post: 'p-2', text: 'The second post says another thing.' },
  ],
  posts: ['p-1', 'p-2'],
  thread: 't-2',
  evidence: "One agent's result. No check yet.",
  check: { state: 'failed', by: 'codex', sameHarness: false },
  ...more,
});

const inView = (mode: ViewMode, element: ReactElement): string =>
  renderToStaticMarkup(
    <ViewContext.Provider value={{ mode, threaded: true, setMode: () => {} }}>
      {element}
    </ViewContext.Provider>,
  );

const brief = (lines: readonly BriefLine[]): Brief => ({
  at,
  top: 'One test runs.',
  lines,
});

const card = (
  shown: Brief,
  mode: ViewMode = 'simple',
  threads: Lab['threads'] = [],
): string =>
  inView(
    mode,
    <BriefCard
      lab={{ away: null, threads } as unknown as Lab}
      brief={shown}
      now={now}
      onDismiss={null}
    />,
  );

await test('each cited post is its own short quote, never one block', () => {
  for (const mode of ['simple', 'technical'] as const) {
    const html = card(brief([line()]), mode);
    assert.equal(html.match(/<blockquote class="quote">/g)?.length, 2);
    assert.equal(html.match(/class="later__text"/g)?.length, 2);
    assert.doesNotMatch(html, /one thing\.\s+The second post/);
  }
  assert.match(card(brief([line()]), 'technical'), /one thing\. \(.*p-1/s);
});

await test('Show more names its state for a screen reader', () => {
  const clip = {
    ref: { current: null },
    open: false,
    toggles: true,
    toggle: () => {},
  };
  assert.match(
    renderToStaticMarkup(<ClipToggle clip={clip} />),
    /aria-expanded="false">Show more</,
  );
  assert.match(
    renderToStaticMarkup(<ClipToggle clip={{ ...clip, open: true }} />),
    /aria-expanded="true">Show less</,
  );
});

await test('a plain line shows its words until the person asks for the quotes', () => {
  const plain = line({ plain: 'It looks open.' });
  const shown = inView('simple', <LineWords line={plain} original={false} />);
  assert.equal(shown, 'It looks open.');
  assert.match(
    inView('simple', <LineWords line={plain} original />),
    /<blockquote/,
  );
});

await test('the tag of a line says Result beside a label with no check, and Held up after a rerun', () => {
  assert.equal(lineWords.result, 'Result');
  const html = card(brief([line({ kind: 'result' })]));
  assert.match(html, /brief-tag--result">Result</);
  assert.doesNotMatch(html, /Held up/);
  assert.match(card(brief([line({ kind: 'held' })])), /Held up/);
});

await test('Decisions shows only when the lab has one', () => {
  assert.doesNotMatch(card(brief([])), /Decisions/);
  const threads = [{ state: 'decided' }] as unknown as Lab['threads'];
  assert.match(card(brief([]), 'simple', threads), /Decisions \(1\)/);
});

await test('a closed agent waits on no row, and a reopen brings its wait back', () => {
  const wait = {
    waiter: 'a-2',
    on: 'a-1',
    onHandle: 'agent-1',
    post: 'p-9',
    subject: 'Do the counts agree?',
  };
  const lab = (state: string): Lab =>
    ({
      directions: [{ agent: 'a-2', state }],
      waits: [wait],
    }) as unknown as Lab;
  for (const state of ['closed', 'stopped']) {
    assert.deepEqual(rowWaits(lab(state)), []);
    assert.equal(waitLine(lab(state), 'a-2'), null);
  }
  assert.equal(
    waitLine(lab('open'), 'a-2'),
    'Waits on Agent 1: Do the counts agree?',
  );
  // An ask to the person stays in Needs you: only the rows leave it out.
  const ofYou = {
    directions: [{ agent: 'a-2', state: 'closed' }],
    waits: [{ ...wait, on: 'person', onHandle: null, reason: 'ask' }],
  } as unknown as Lab;
  assert.equal(askedOfYou(ofYou).length, 1);
});

const asked = (answer: Partial<BriefLine>): Lab =>
  ({
    questions: [
      {
        id: 'q-1',
        at,
        text: 'Which test matters most?',
        state: 'answered',
        answer: line({
          kind: 'answer',
          plain: 'No post says which test matters most.',
          ...answer,
        }),
      } satisfies Question,
    ],
  }) as unknown as Lab;

await test('an answer shows as written, in both views, with its sources one click away', () => {
  const lab = asked({
    check: {
      state: 'failed',
      by: 'codex',
      sameHarness: false,
      failure: { first: { kind: 'added-fact', claim: 'X.' }, count: 1 },
    },
  });
  for (const mode of ['simple', 'technical'] as const) {
    const html = inView(mode, <Answers lab={lab} now={now} />);
    assert.match(html, /No post says which test matters most\./);
    assert.match(html, /Failed its check\. Its posts do not say: X\. No agent/);
    assert.doesNotMatch(html, /Answered from the record/);
    assert.doesNotMatch(html, /<blockquote/);
    assert.match(html, /href="#\/thread\/t-2">2 posts</);
    assert.match(html, /Original posts/);
  }
});

await test('an answer that waits for its check says that it is not checked, and names no checker', () => {
  const pending = { state: 'pending', by: null, sameHarness: false } as const;
  const html = inView(
    'simple',
    <Answers lab={asked({ check: pending })} now={now} />,
  );
  assert.match(html, /Not checked yet\. No agent was disturbed\./);
  assert.doesNotMatch(html, /second agent|Answered from the record/);
  assert.match(html, /No post says which test matters most\./);
});

await test('an answer with no post to cite has no link and no toggle', () => {
  const html = inView(
    'simple',
    <Answers
      lab={asked({
        quotes: [],
        posts: [],
        check: { state: 'pending', by: null, sameHarness: false },
      })}
      now={now}
    />,
  );
  assert.match(html, /No post says which test matters most\./);
  assert.doesNotMatch(html, /0 posts|Original posts/);
});

await test('an answer with no plain words shows each post as its own quote', () => {
  const html = inView(
    'simple',
    <Answers
      lab={asked({
        plain: null,
        check: { state: 'withheld', by: null, sameHarness: false },
      })}
      now={now}
    />,
  );
  assert.equal(html.match(/<blockquote/g)?.length, 2);
  assert.doesNotMatch(html, /Original posts/);
});
