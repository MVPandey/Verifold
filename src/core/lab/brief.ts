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
    'id' | 'state' | 'by' | 'direction' | 'joined'
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

/** The one reading of the records that both top lines take. */
interface TopReading {
  /** Each direction, in the order of `standings`, with the call that it waits on. */
  readonly rows: readonly {
    readonly id: string;
    readonly standing: Standing;
    readonly call: string | null;
  }[];
  /** The open calls of no direction, such as Verifold's own. */
  readonly loose: readonly string[];
}

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

function readTop(records: TopRecords): TopReading {
  const open = records.calls.filter((call) => call.state === 'open');
  const waiting = new Set(open.flatMap(askerDirections));
  const order = Object.keys(standings);
  return {
    rows: records.directions
      .map((direction) => {
        const standing = standingOf(direction, waiting, records.runs);
        return {
          id: direction.id,
          standing,
          call:
            standing === 'decision'
              ? (open.find((call) =>
                  askerDirections(call).includes(direction.id),
                )?.id ?? null)
              : null,
        };
      })
      .sort((a, b) => order.indexOf(a.standing) - order.indexOf(b.standing)),
    loose: open
      .filter((call) =>
        askerDirections(call).every((direction) => direction === null),
      )
      .map((call) => call.id),
  };
}

/**
 * The top line of a brief, from the records of directions, calls, and runs,
 * such as "One test failed, one is running, one needs your decision, and one
 * has not run yet." Each direction counts once. A call of no direction, such
 * as Verifold's own, adds a sentence.
 */
export function briefTop(records: TopRecords): string {
  const { rows, loose } = readTop(records);
  const counts = new Map<Standing, number>();
  for (const { standing } of rows)
    counts.set(standing, (counts.get(standing) ?? 0) + 1);
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
  return loose.length
    ? `${line} The lab also has ${numberWord(loose.length)} decision${loose.length > 1 ? 's' : ''} for you.`
    : line;
}

/**
 * The top line with the IDs of its records, for the Technical view, such as
 * "d-1 failed. d-4 is running. d-2 waits on c-4. c-7 waits on you." It reads
 * what `briefTop` reads, so the two say the same.
 */
export function briefTopIds(records: TopRecords): string {
  const { rows, loose } = readTop(records);
  return (
    [
      ...rows.map(
        ({ id, standing, call }) =>
          `${id} ${call ? `waits on ${call}` : standings[standing][0]}.`,
      ),
      ...loose.map((call) => `${call} waits on you.`),
    ].join(' ') || 'No test has started yet.'
  );
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

/** The cited posts quoted unchanged, each apart from its ID, so a view can show the ID or leave it out and touch no agent's words. Verifold builds this, and no model touches it. */
export function quotesOf(
  posts: readonly Pick<Post, 'id' | 'text'>[],
): readonly { readonly post: string; readonly text: string }[] {
  return posts.map(({ id, text }) => ({ post: id, text }));
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

const amount = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.?\d+)(?:[eE][-+]?\d+)?(?:[kKM](?![\p{L}\d])|\s+(?:thousand|million)\b)?`;

const separator = String.raw`(?:\s*[-–—/]\s*|\s+to\s+)`;

const percent = String.raw`\s*(?:%|[Pp]ercent\b|[Pp]er cent\b)`;

/** Amounts that a range or a list joins, as in 40/55/60% or 20 to 30%, so a percent sign reaches each. A hyphen after a word or a digit is no sign. */
const amounts = new RegExp(
  String.raw`(?:(?<![\p{L}\d.)\]])[-−])?(?<![\p{L}\d.])${amount}(?:${separator}[-−]?${amount})*(${percent})?`,
  'gu',
);

/** One amount of a list, with its sign. */
const amountPart = new RegExp(
  String.raw`(?:^|${separator})([-−]?)(${amount})`,
  'gu',
);

/** Numbers that a line can spell out. */
const spelled: ReadonlyMap<string, number> = new Map([
  ...smallNumbers.map((word, index) => [word, index] as const),
  ['thirty', 30],
  ['forty', 40],
  ['fifty', 50],
  ['sixty', 60],
  ['seventy', 70],
  ['eighty', 80],
  ['ninety', 90],
  ['hundred', 100],
  ['thousand', 1000],
  ['million', 1_000_000],
]);

const spelledWord = [...spelled.keys()].join('|');

const spelledNumbers = new RegExp(
  String.raw`\b(?:${spelledWord})(?:[\s-]+(?:${spelledWord}))*\b(${percent})?`,
  'gi',
);

/** The value of an amount with its comma thousands and its k or M. */
function amountValue(sign: string, raw: string): string {
  const scale = /[kK]$|thousand$/.test(raw)
    ? 1000
    : /M$|million$/.test(raw)
      ? 1_000_000
      : 1;
  const value = Number.parseFloat(raw.replaceAll(',', '')) * scale;
  return String(Number((sign ? -value : value).toPrecision(12)));
}

/** The value of spelled words, such as "two hundred" or "thirty-five". */
function spelledValue(words: string): number {
  let total = 0;
  let current = 0;
  for (const word of words.toLowerCase().split(/[\s-]+/)) {
    const value = spelled.get(word) ?? 0;
    if (value === 100) current = (current || 1) * 100;
    else if (value >= 1000) {
      total += (current || 1) * value;
      current = 0;
    } else current += value;
  }
  return total + current;
}

/**
 * The numbers of a text: times, then amounts, then spelled numbers. Comma
 * thousands, a decimal's zeros, and a leading zero do not count. A sign counts.
 * "One" alone stays out: "no one" and "one of them" count nothing.
 */
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
      [...match[0].matchAll(amountPart)].map(
        (part): Figure => ({
          value: amountValue(part[1] ?? '', part[2] ?? ''),
          percent: match[1] !== undefined,
        }),
      ),
    ),
    ...[...rest.matchAll(spelledNumbers)].flatMap((match): readonly Figure[] =>
      /^one$/i.test(match[0])
        ? []
        : [
            {
              value: String(spelledValue(match[0])),
              percent: match[1] !== undefined,
            },
          ],
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

/** The posts that a label reads: the cited posts, what they reply to, and the checks, reruns, objections, and accepting answers of any of those. */
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
  // Oldest first, so a check of a check follows its target. An answer that accepts an objection ends it.
  for (const post of all)
    if (
      (tests.has(post.kind) || post.accepts) &&
      post.replyTo &&
      kept.has(post.replyTo)
    )
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

/** What a label reads of a check. */
type EvidenceCheck = Pick<
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
  | 'blind'
>;

/** One thing that tested a post. */
interface Form {
  readonly at: string;
  readonly target: string | null;
  readonly words: string;
  readonly rerun: boolean;
}

const outcomeWords = { holds: 'held', fails: 'failed', differs: 'differed' };

/** A form with how it ended. */
const ending = (
  words: string,
  outcome: keyof typeof outcomeWords | null | undefined,
): string => (outcome ? `${words} ${outcomeWords[outcome]}` : words);

/** What a check of Verifold did. A `code-read` is no rerun, whatever it found. */
function checkForm(check: EvidenceCheck): Form {
  const rerun = check.method === 'rerun';
  return {
    at: check.endedAt ?? check.queuedAt,
    target: check.claim,
    rerun,
    words: ending(
      rerun
        ? `${check.blind ? '' : 'not-blind '}rerun${check.sameHarness ? ' on the same harness' : ''}`
        : 'code check',
      check.outcome,
    ),
  };
}

/** What a `check` post did, as its author says. Its author read the lab, so its rerun is not blind. A check with no method is the weakest form. */
function postForm(post: Post): Form {
  const base = { at: post.at, target: post.replyTo ?? null };
  const raters = post.raters ?? 1;
  const words = {
    rerun: 'not-blind rerun',
    'code-read': 'code check',
    ratings: `${numberWord(raters)} AI rating${raters > 1 ? 's' : ''} per answer`,
  }[post.method ?? 'rerun'];
  return {
    ...base,
    rerun: post.method === 'rerun',
    words: ending(post.method ? words : 'an agent check', post.outcome),
  };
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
  if (!authors.size) return "Your own words and Verifold's record.";
  const results = subjects.every((post) => resultKinds.has(post.kind));
  const noun = `${results ? 'result' : 'post'}${subjects.length > 1 ? 's' : ''}`;
  return `${capitalized(numberWord(authors.size))} agent${authors.size > 1 ? "s'" : "'s"} ${noun}. No check yet.`;
}

/**
 * How strong the record behind a line is, in the true weakest form across its
 * results: "One agent's result. No check yet.", "Code check failed, then two AI
 * ratings per answer failed. No rerun.", or "Rerun held on 1 of 2 results. No
 * rerun on the other." It reads records only, never the words of the line, so
 * no writer can raise it. `posts`: what `evidencePosts` gives. `checks`: the
 * lab's checks. A `code-read` is no rerun, a check that did not end counts for
 * nothing, and a rerun that was not blind says so.
 */
export function evidenceLabel(
  posts: readonly Post[],
  checks: readonly EvidenceCheck[],
): string {
  if (!posts.length) return 'No cited post is on the board.';
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
  const results = posts.filter((post) => resultKinds.has(post.kind));
  const disputed = [...openObjections(posts, checks).keys()].some((id) =>
    ids.has(id),
  );
  const open = disputed ? ' Disputed.' : '';
  if (!forms.length)
    return `${noCheckYet(results.length ? results : posts)}${open}`;
  const joined = (list: readonly Form[]): string =>
    capitalized([...new Set(list.map((form) => form.words))].join(', then '));
  const reruns = forms.filter((form) => form.rerun);
  const rerun = results.filter((post) =>
    reruns.some((form) => form.target === post.id),
  );
  const others = results.length - rerun.length;
  if (rerun.length && others)
    return `${joined(reruns)} on ${rerun.length} of ${results.length} results. No rerun on the other${others > 1 ? ` ${others}` : ''}.${open}`;
  const left = results.filter(
    (post) => !forms.some((form) => form.target === post.id),
  ).length;
  const part = left
    ? ` on ${results.length - left} of ${results.length} results`
    : '';
  const rest = left
    ? ` ${left} ${left > 1 ? 'have' : 'has'} no check yet.`
    : '';
  return `${joined(forms)}${part}.${rest}${reruns.length ? '' : ' No rerun.'}${open}`;
}
