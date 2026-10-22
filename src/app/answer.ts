import type {
  BringRead,
  CheckItem,
  Direction,
  DirectionCounts,
  Fact,
  Lab,
  Post,
  Verdict,
  Work,
} from '../protocol/api.ts';
import { clock, harnessName } from './format.ts';

/**
 * Where a finding comes from, as the lab records it. `data`: a run backs it.
 * `literature`: a source that the plan checked. `reasoning`: nothing that a
 * run did. Null: the records on this page cannot tell, so the finding shows
 * without a tag.
 */
export type Tag = 'data' | 'literature' | 'reasoning' | null;

export const tagNames: Readonly<Record<Exclude<Tag, null>, string>> = {
  data: 'Data',
  literature: 'Literature',
  reasoning: 'Our reasoning',
};

/** One line of "What we found": a direction's verdict and its evidence, or a source of the plan. */
export interface Finding {
  readonly key: string;
  readonly tag: Tag;
  /** The direction that it settles. Null for a source of the plan. */
  readonly direction: Direction | null;
  readonly text: string;
  /** The runs that back it. */
  readonly runs: readonly string[];
  /** The post with its evidence. */
  readonly post: string | null;
  /** How a rerun by the other harness tested it, or null when the page cannot tell. */
  readonly check: string | null;
  /** Why it has no tag. */
  readonly untagged: string | null;
  /** The source of a plan fact. `url` only for a web address. */
  readonly source: {
    readonly text: string;
    readonly url: string | null;
    readonly date: string | null;
  } | null;
}

/** Post kinds that a check reruns: a claim, evidence, or a rerun that cites a run. */
const checkable = new Set<Post['kind']>(['claim', 'evidence', 'rerun']);

/** Verdicts that settle a direction, in the order the answer lists them. */
const settled: Readonly<Partial<Record<Verdict, number>>> = {
  'holds-up': 0,
  leading: 1,
  'ruled-out': 2,
};

/**
 * How the newest check of a post went, in plain words. "Not rerun yet" when
 * the lab has none, and null when this page leaves checks out, so it cannot
 * tell.
 */
export function checkLine(lab: Lab, post: string): string | null {
  const latest = lab.checks.filter((check) => check.post === post).at(-1);
  if (!latest) return lab.omitted.checks === undefined ? 'Not rerun yet' : null;
  return checkWords(latest);
}

/** How one check went, in plain words, such as "Codex reran it, and it held". */
export function checkWords(check: CheckItem): string {
  const who = harnessName(check.harness);
  switch (check.state) {
    case 'queued':
      return `A rerun by ${who} waits to start`;
    case 'running':
      return `${who} reruns it now`;
    case 'failed':
    case 'dropped':
      return `A rerun by ${who} did not finish`;
    case 'done':
      return check.outcome === 'holds'
        ? `${who} reran it, and it held`
        : check.outcome === 'fails'
          ? `${who} reran it, and it did not hold`
          : check.outcome === 'differs'
            ? `${who} reran it, and got a different result`
            : `${who} reran it`;
  }
}

function directionFinding(
  direction: Direction,
  lab: Lab,
  posts: ReadonlyMap<string, Post>,
): Finding {
  const evidence = direction.evidence;
  const post = evidence ? (posts.get(evidence.post) ?? null) : null;
  const runs = [
    ...new Set([
      ...(evidence?.run ? [evidence.run] : []),
      ...(post?.proof.flatMap((proof) =>
        proof.type === 'run' ? [proof.run] : [],
      ) ?? []),
    ]),
  ];
  // A run backs it: data. Its post is here and cites no run: reasoning. Its post is older than this page: unknown.
  const tag: Tag = !evidence
    ? null
    : runs.length
      ? 'data'
      : post
        ? 'reasoning'
        : null;
  const checked =
    tag === 'data' && evidence && (!post || checkable.has(post.kind))
      ? checkLine(lab, evidence.post)
      : null;
  return {
    key: direction.id,
    tag,
    direction,
    text: evidence?.text ?? '',
    runs,
    post: evidence?.post ?? null,
    check: checked,
    untagged:
      tag !== null
        ? null
        : evidence
          ? 'The post behind it is older than this page shows, so it has no tag.'
          : 'The lab records no evidence line for it, so it has no tag.',
    source: null,
  };
}

function factFinding(fact: Fact, index: number): Finding | null {
  if (!fact.source) return null;
  return {
    key: `fact-${index}`,
    tag: 'literature',
    direction: null,
    text: fact.claim,
    runs: [],
    post: null,
    check: null,
    untagged: null,
    source: {
      text: fact.source,
      url: /^https?:\/\//i.test(fact.source) ? fact.source : null,
      date: fact.sourceDate,
    },
  };
}

/**
 * "What we found": each settled direction (holds up, leading, ruled out)
 * with its evidence, then the sourced facts that the plan rests on. A fact
 * with no source is unverified, so it is not a finding.
 */
export function findings(lab: Lab): Finding[] {
  const posts = new Map(lab.board.posts.map((post) => [post.id, post]));
  const directions = lab.directions
    .filter((direction) => settled[direction.verdict] !== undefined)
    .sort((a, b) => (settled[a.verdict] ?? 0) - (settled[b.verdict] ?? 0))
    .map((direction) => directionFinding(direction, lab, posts));
  const facts = (lab.plan?.facts ?? []).flatMap((fact, index) => {
    const found = factFinding(fact, index);
    return found ? [found] : [];
  });
  return [...directions, ...facts];
}

/**
 * The person signed off. A snapshot of an older server could leave a
 * sign-off out of a large lab: then the lab is signed off too, with no time
 * or line to show.
 */
export function signedOff(lab: Lab): boolean {
  return lab.signoff !== null || lab.omitted.signoff !== undefined;
}

/**
 * The lab's direction counts: Verifold's, over all its directions. An older
 * server sends none: then the directions of this page, when it has them all.
 */
function directionCounts(lab: Lab): DirectionCounts | null {
  if (lab.directionCounts) return lab.directionCounts;
  if (lab.omitted.directions !== undefined) return null;
  return {
    total: lab.directions.length,
    holdsUp: lab.directions.filter(
      (direction) => direction.verdict === 'holds-up',
    ).length,
    ruledOut: lab.directions.filter(
      (direction) => direction.verdict === 'ruled-out',
    ).length,
    open: stillOpen(lab).length,
  };
}

/**
 * "The answer, draft · 2 of 4 directions hold up · 1 ruled out · 1 still
 * open". After a sign-off, when it was signed. "Still open" counts what the
 * "Still open" list shows: open directions with no verdict or a disputed one.
 */
export function answerStatus(lab: Lab): string {
  const head = lab.signoff
    ? `Signed off at ${clock(lab.signoff.at)}`
    : signedOff(lab)
      ? 'Signed off'
      : 'The answer, draft';
  const counts = directionCounts(lab);
  if (!counts) return `${head} · this view leaves out some directions`;
  const { total, holdsUp, ruledOut, open } = counts;
  if (!total) return `${head} · no direction yet`;
  return [
    head,
    `${holdsUp} of ${total} ${total === 1 ? 'direction holds' : 'directions hold'} up`,
    ruledOut ? `${ruledOut} ruled out` : null,
    open ? `${open} still open` : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

/** Directions that are not settled: open with no verdict, or disputed. */
export function stillOpen(lab: Lab): Direction[] {
  return lab.directions.filter(
    (direction) =>
      direction.state === 'open' &&
      (direction.verdict === 'open' || direction.disputed),
  );
}

/** Directions that stopped or closed with no verdict. */
export function stoppedWithout(lab: Lab): Direction[] {
  return lab.directions.filter(
    (direction) => direction.state !== 'open' && direction.verdict === 'open',
  );
}

/**
 * The person's own calls that stand, oldest first: the option that they
 * picked, or their words in quotes. An answer that Verifold still applies
 * does not stand yet.
 */
export function yourCalls(lab: Lab): string[] {
  return [...lab.answered]
    .reverse()
    .filter((call) => call.state === 'answered' && !call.applying)
    .flatMap((call) => {
      if (call.answer) {
        const label = call.options[call.answer.option]?.label;
        return label ? [label] : [];
      }
      if (call.words) {
        const words =
          call.words.length > 120
            ? `${call.words.slice(0, 119).trimEnd()}…`
            : call.words;
        return [`"${words}"`];
      }
      return [];
    });
}

/** "12 runs, 2 failed or stopped. Verifold keeps every run." When the page leaves runs out, only the count. */
export function runsLine(lab: Lab): string {
  const total = lab.runs.length + (lab.omitted.runs ?? 0);
  if (!total) return 'No run yet.';
  const runs = `${total} ${total === 1 ? 'run' : 'runs'}`;
  if (lab.omitted.runs !== undefined)
    return `${runs}. Verifold keeps every run.`;
  const failed = lab.runs.filter(
    (run) =>
      run.status !== 'done' &&
      run.status !== 'running' &&
      run.status !== 'queued',
  ).length;
  return `${runs}, ${failed} failed or stopped. Verifold keeps every run.`;
}

/** Bring-in actions that run in the background. */
const bringActions = new Set(['lab-bring-look', 'lab-bring', 'lab-bring-undo']);

/** The bring-in actions of a direction in the background, running or failed, oldest first. */
function bringWorks(lab: Lab, direction: string): Work[] {
  return lab.works.filter(
    (work) => bringActions.has(work.action) && work.direction === direction,
  );
}

/** The newest bring-in action of a direction in the background, running or failed, or null. */
export function bringWork(lab: Lab, direction: string): Work | null {
  return bringWorks(lab, direction).at(-1) ?? null;
}

/**
 * When a bring-in page reads its files again: its direction's newest commit,
 * bring-ins, or undos changed, or a bring-in action of it started, ended, or
 * failed.
 */
export function bringKey(lab: Lab, direction: Direction): string {
  const works = bringWorks(lab, direction.id)
    .map((work) => `${work.action}:${work.at}:${work.error ?? ''}`)
    .join(',');
  return `${direction.head}|${direction.brought?.files ?? 0}|${direction.brought?.lastAt ?? ''}|${direction.undoneAt ?? ''}|${works}`;
}

/** The files that a bring-in ticks first: those it can bring in that did not come in already. */
export function firstTicked(read: BringRead): Set<string> {
  return new Set(
    (read.list?.files ?? [])
      .filter((file) => file.ticked && file.out === null && file.since === null)
      .map((file) => file.path),
  );
}

/** The person's ticks on a bring-in page, for the commit that they looked at. */
export interface Ticks {
  readonly commit: string;
  readonly paths: ReadonlySet<string>;
}

/**
 * The files that a bring-in sends: the person's ticks at the commit shown,
 * or else the first ticks. Only files that can come in now count, so a file
 * that came in meanwhile is not sent again.
 */
export function chosenFiles(
  read: BringRead | null,
  ticks: Ticks | null,
): ReadonlySet<string> {
  if (!read?.list) return new Set();
  const { list } = read;
  const can = new Set(
    list.files
      .filter((file) => file.out === null && file.since === null)
      .map((file) => file.path),
  );
  const picked =
    ticks?.commit === list.commit ? ticks.paths : firstTicked(read);
  return new Set([...picked].filter((path) => can.has(path)));
}

/** What a bring-in sends: the commit that the person looked at, and the ticked files, sorted. */
export interface BringIntent {
  readonly commit: string;
  readonly files: readonly string[];
}

/**
 * Two bring-ins are one intent when they name the same commit and the same
 * files. So a retry after a lost answer keeps its key, and a bring-in at a
 * newer commit is a new intent, also with the same files.
 */
export function sameBring(a: BringIntent, b: BringIntent): boolean {
  return (
    JSON.stringify([a.commit, a.files]) === JSON.stringify([b.commit, b.files])
  );
}

/** "2 files brought in, last at 21:40", or null when none came in. */
export function broughtLine(direction: Direction): string | null {
  const brought = direction.brought;
  if (!brought) return null;
  return `${brought.files} ${brought.files === 1 ? 'file' : 'files'} brought in, last at ${clock(brought.lastAt)}`;
}
