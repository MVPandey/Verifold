/**
 * What a person reads of a lab: pure functions over records, with no lab and
 * no model. A summary is the weakest layer of a research system, so the parts
 * that can come from the record do: the top line, the evidence label, and the
 * quote. The Coordinator writes only the plain words, and `plainNumbersMatch`
 * and a line check test those words against their posts.
 */
import { number, type Post, type PostKind } from '../board.ts';
import { runActive, type RunRecord } from '../runs.ts';
import { openObjections } from './post-rules.ts';
import type { Call, Check, Direction, Thread } from './schema.ts';
import { askerDirections } from './words.ts';

const smallNumbers =
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(
    ' ',
  );

/** A count in words up to twenty, as in "two tests", then in digits. */
export function numberWord(value: number): string {
  return smallNumbers[value] ?? String(value);
}

const capitalized = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** Words of a list: "a", "a and b", "a, b, and c". */
function listed(parts: readonly string[]): string {
  if (parts.length < 3) return parts.join(' and ');
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1) ?? ''}`;
}

/** The records of the top line. */
export interface TopRecords {
  readonly directions: readonly Pick<Direction, 'id' | 'state' | 'verdict'>[];
  readonly calls: readonly Pick<
    Call,
    'state' | 'by' | 'direction' | 'joined'
  >[];
  readonly runs: readonly Pick<RunRecord, 'direction' | 'status'>[];
}

/** Where a direction stands, in the order of the top line, with the words for one and for many. */
const standings = {
  held: ['held up', 'held up'],
  failed: ['failed', 'failed'],
  running: ['is running', 'are running'],
  decision: ['needs your decision', 'need your decision'],
  ran: ['has run, with no verdict yet', 'have run, with no verdict yet'],
  unrun: ['has not run yet', 'have not run yet'],
  stopped: ['was stopped', 'were stopped'],
} as const;

type Standing = keyof typeof standings;

function standingOf(
  direction: TopRecords['directions'][number],
  waiting: ReadonlySet<string | null>,
  runs: TopRecords['runs'],
): Standing {
  if (direction.verdict === 'ruled-out') return 'failed';
  if (direction.verdict === 'holds-up') return 'held';
  if (direction.state !== 'open') return 'stopped';
  if (waiting.has(direction.id)) return 'decision';
  const own = runs.filter((run) => run.direction === direction.id);
  if (own.some(runActive)) return 'running';
  return own.length ? 'ran' : 'unrun';
}

/**
 * The top line of a brief, from the records of directions, calls, and runs,
 * such as "One test failed, one is running, one needs your decision, and one
 * has not run yet." Each direction counts once. A call of no direction, such
 * as Verifold's own, adds a sentence.
 */
export function briefTop(records: TopRecords): string {
  const open = records.calls.filter((call) => call.state === 'open');
  const waiting = new Set(open.flatMap(askerDirections));
  const counts = new Map<Standing, number>();
  for (const direction of records.directions) {
    const standing = standingOf(direction, waiting, records.runs);
    counts.set(standing, (counts.get(standing) ?? 0) + 1);
  }
  const parts = (Object.keys(standings) as Standing[]).flatMap((standing) => {
    const count = counts.get(standing);
    return count
      ? [{ count, words: standings[standing][count > 1 ? 1 : 0] }]
      : [];
  });
  const [first, ...rest] = parts;
  const line = first
    ? `${listed([
        `${capitalized(numberWord(first.count))} test${first.count > 1 ? 's' : ''} ${first.words}`,
        ...rest.map(({ count, words }) => `${numberWord(count)} ${words}`),
      ])}.`
    : 'No test has started yet.';
  const loose = open.filter((call) =>
    askerDirections(call).every((direction) => direction === null),
  ).length;
  return loose
    ? `${line} The lab also has ${numberWord(loose)} decision${loose > 1 ? 's' : ''} for you.`
    : line;
}

/** What makes an update due: the states of directions and threads, as one comparable text. */
export function stateKey(
  directions: readonly Pick<Direction, 'id' | 'state' | 'verdict'>[],
  threads: readonly Pick<Thread, 'id' | 'state'>[],
): string {
  return JSON.stringify([
    directions.map(({ id, state, verdict }) => [id, state, verdict]),
    threads.map(({ id, state }) => [id, state]),
  ]);
}

/** The cited posts quoted unchanged, each with its ID. Verifold builds this, and no model touches it. */
export function quoteOf(posts: readonly Pick<Post, 'id' | 'text'>[]): string {
  return posts.map((post) => `${post.text} (${post.id})`).join(' ');
}

/** One number of a text. */
interface Figure {
  readonly value: string;
  readonly percent: boolean;
}

/** IDs and agent names hold digits that are no numbers of the work, such as p-12 or Agents 1 and 3. */
const names =
  /\b(?:p|r|d|t|k|c|a|q|n|l|lease|agent|checker|claude|codex)-\d+(?:\.\d+)?\b|\b(?:agents?|checkers?|helpers?)\s+\d+(?:\.\d+)?(?:(?:\s*,\s*|\s+and\s+)\d+(?:\.\d+)?)*/gi;

const clock = /(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g;

const amount = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.?\d+)(?:e[-+]?\d+)?`;

const amountOnly = new RegExp(amount, 'gi');

/** Amounts that a range or a list joins, as in 40/55/60% or 20 to 30%, so a percent sign reaches each. */
const amounts = new RegExp(
  String.raw`(?<![\p{L}\d.])${amount}(?:(?:\s*[-–—/]\s*|\s+to\s+)${amount})*(\s*(?:%|percent\b|per cent\b))?`,
  'giu',
);

/** Numbers that a line can spell out. "One" stays out: "no one" and "one of them" count nothing. */
const spelled: ReadonlyMap<string, number> = new Map([
  ...smallNumbers.slice(2).map((word, index) => [word, index + 2] as const),
  ...[30, 40, 50, 60, 70, 80, 90].map(
    (value) =>
      [
        ['thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'][
          value / 10 - 3
        ] ?? '',
        value,
      ] as const,
  ),
  ['hundred', 100],
  ['thousand', 1000],
  ['million', 1_000_000],
]);

const spelledWords = new RegExp(
  `\\b(?:${[...spelled.keys()].join('|')})\\b`,
  'gi',
);

/** The numbers of a text: times, then amounts, then spelled numbers. Comma thousands, a decimal's zeros, and a leading zero do not count. */
function figures(text: string): readonly Figure[] {
  const bare = text.replace(names, ' ');
  const times = [...bare.matchAll(clock)].map(
    (match): Figure => ({
      value: `${Number(match[1])}:${match[2] ?? ''}`,
      percent: false,
    }),
  );
  const rest = bare.replace(clock, ' ');
  return [
    ...times,
    ...[...rest.matchAll(amounts)].flatMap((match) =>
      (match[0].match(amountOnly) ?? []).map(
        (raw): Figure => ({
          value: String(Number(raw.replaceAll(',', ''))),
          percent: match[1] !== undefined,
        }),
      ),
    ),
    ...[...rest.matchAll(spelledWords)].map(
      (match): Figure => ({
        value: String(spelled.get(match[0].toLowerCase())),
        percent: false,
      }),
    ),
  ];
}

/** A post's time on this computer's clock, which is what a person reads. */
function postClock(at: string): string {
  const date = new Date(at);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * The numbers of a plain line that its posts do not hold, each as it counts
 * here, such as "91.5%". A percent needs a percent in a post: 12 of 60 does
 * not back 20%. A time can be the time of a post.
 */
export function strayNumbers(
  plain: string,
  posts: readonly Pick<Post, 'text' | 'at'>[],
): readonly string[] {
  const known = posts.flatMap((post) => [
    ...figures(post.text),
    { value: postClock(post.at), percent: false },
  ]);
  return figures(plain)
    .filter(
      (figure) =>
        !known.some(
          (entry) =>
            entry.value === figure.value && (entry.percent || !figure.percent),
        ),
    )
    .map((figure) => `${figure.value}${figure.percent ? '%' : ''}`);
}

/** Each number of a plain line appears in its cited posts. It cannot tell a number in the wrong scope: the line check does that. */
export function plainNumbersMatch(
  plain: string,
  posts: readonly Pick<Post, 'text' | 'at'>[],
): boolean {
  return !strayNumbers(plain, posts).length;
}

/** The posts that a label reads: the cited posts, what they reply to, and the checks, reruns, and objections of any of those. */
export function evidencePosts(
  cited: readonly Post[],
  all: readonly Post[],
): readonly Post[] {
  const byId = new Map(all.map((post) => [post.id, post]));
  const kept = new Map(cited.map((post) => [post.id, post]));
  // A Map's iteration reaches the entries that this loop adds, so a chain of replies ends at its root.
  for (const post of kept.values()) {
    const target = post.replyTo ? byId.get(post.replyTo) : undefined;
    if (target) kept.set(target.id, target);
  }
  const tests: ReadonlySet<PostKind> = new Set(['check', 'rerun', 'objection']);
  // Oldest first, so a check of a check follows its target.
  for (const post of all)
    if (tests.has(post.kind) && post.replyTo && kept.has(post.replyTo))
      kept.set(post.id, post);
  return [...kept.values()].sort((a, b) => number(a.id) - number(b.id));
}

/** The kinds that state what a model did. Old labs have claims and evidence. */
const resultKinds: ReadonlySet<PostKind> = new Set([
  'result',
  'ruled-out',
  'claim',
  'evidence',
]);

/** One thing that tested a post. */
interface Form {
  readonly at: string;
  readonly target: string | null;
  readonly words: string;
  readonly rerun: boolean;
}

const rerunWords = { holds: 'held', fails: 'failed', differs: 'differed' };

/** What a check of Verifold did. A `code-read` is no rerun, whatever it found. */
function checkForm(
  check: Pick<
    Check,
    'claim' | 'endedAt' | 'method' | 'outcome' | 'sameHarness' | 'queuedAt'
  >,
): Form {
  const rerun = check.method === 'rerun';
  return {
    at: check.endedAt ?? check.queuedAt,
    target: check.claim,
    rerun,
    words: rerun
      ? `rerun ${check.sameHarness ? 'on the same harness ' : ''}${check.outcome ? rerunWords[check.outcome] : 'ended'}`
      : 'code check',
  };
}

/** What a `check` post did, as its author says. A check with no method is the weakest form. */
function postForm(post: Post): Form {
  const base = { at: post.at, target: post.replyTo ?? null };
  switch (post.method) {
    case 'rerun':
      return {
        ...base,
        rerun: true,
        words: `rerun ${post.outcome ? rerunWords[post.outcome] : 'ended'}`,
      };
    case 'code-read':
      return { ...base, rerun: false, words: 'code check' };
    case 'ratings': {
      const raters = post.raters ?? 1;
      return {
        ...base,
        rerun: false,
        words: `${numberWord(raters)} AI rating${raters > 1 ? 's' : ''} per answer`,
      };
    }
    default:
      return { ...base, rerun: false, words: 'an agent check' };
  }
}

/** Who wrote the posts of a line that nothing tested. */
function noCheckYet(subjects: readonly Post[]): string {
  const authors = new Set(subjects.map((post) => post.author));
  if ([...authors].every((author) => author === 'person'))
    return 'Your own words.';
  if ([...authors].every((author) => author === 'verifold'))
    return "Verifold's own record.";
  authors.delete('person');
  authors.delete('verifold');
  const results = subjects.every((post) => resultKinds.has(post.kind));
  const noun = `${results ? 'result' : 'post'}${subjects.length > 1 ? 's' : ''}`;
  return `${capitalized(numberWord(authors.size))} agent${authors.size > 1 ? "s'" : "'s"} ${noun}. No check yet.`;
}

/**
 * How strong the record behind a line is, in the true weakest form: "One
 * agent's result. No check yet." or "Code check, then two AI ratings per
 * answer. No rerun." It reads records only, never the words of the line, so
 * no writer can raise it. `posts`: what `evidencePosts` gives. `checks`: the
 * lab's checks. A `code-read` is no rerun, a check that did not end counts for
 * nothing, and a result with no test says so also when another result passed.
 */
export function evidenceLabel(
  posts: readonly Post[],
  checks: readonly Pick<
    Check,
    | 'state'
    | 'objections'
    | 'claim'
    | 'result'
    | 'endedAt'
    | 'method'
    | 'outcome'
    | 'sameHarness'
    | 'queuedAt'
  >[],
): string {
  const ids = new Set(posts.map((post) => post.id));
  const forms = [
    ...checks
      .filter(
        (check) =>
          check.state === 'done' &&
          (ids.has(check.claim) ||
            (check.result !== null && ids.has(check.result))),
      )
      .map(checkForm),
    ...posts.filter((post) => post.kind === 'check').map(postForm),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!posts.length) return 'No cited post is on the board.';
  const results = posts.filter((post) => resultKinds.has(post.kind));
  const disputed = [...openObjections(posts, checks).keys()].some((id) =>
    ids.has(id),
  );
  const open = disputed ? ' Disputed.' : '';
  if (!forms.length)
    return `${noCheckYet(results.length ? results : posts)}${open}`;
  const tested = new Set(forms.map((form) => form.target));
  const left = results.filter((post) => !tested.has(post.id)).length;
  const words = [...new Set(forms.map((form) => form.words))].join(', then ');
  const part = left
    ? ` on ${results.length - left} of ${results.length} results`
    : '';
  const rest = left
    ? ` ${left} ${left > 1 ? 'have' : 'has'} no check yet.`
    : '';
  const rerun = forms.some((form) => form.rerun) ? '' : ' No rerun.';
  return `${capitalized(words)}${part}.${rest}${rerun}${open}`;
}
