import type { CollabPage, Disagreement, Need } from '../protocol/api.ts';
import { andList } from '../ui/call-words.ts';
import { agentsWord, type Chip } from './agent-rows.ts';
import { clock, roleName, since } from './format.ts';
import { href } from './route.ts';
import type { ViewMode } from './view-mode.ts';

/** One row of "How they work together". Verifold writes each line from records. */
export interface CollabRow {
  readonly key: string;
  readonly title: string;
  /** Null: the row states a fact and has no state. */
  readonly chip: Chip | null;
  readonly sub: string;
  readonly to: string | null;
}

const who = (handle: string | null, author = ''): string =>
  handle ? roleName(handle) : author === 'verifold' ? 'Verifold' : 'You';

const whose = (handle: string | null, author: string): string => {
  const name = who(handle, author);
  return name === 'You' ? 'your' : `${name}'s`;
};

/** What the newest check of a disputed post did, as the record says. */
function checkLine(check: Disagreement['check']): string {
  if (!check) return 'No check yet.';
  switch (check.state) {
    case 'queued':
      return 'A check waits to start.';
    case 'running':
      return 'A check runs now.';
    case 'done': {
      const how = check.method === 'code-read' ? 'A code check' : 'A rerun';
      return check.outcome === 'holds'
        ? `${how} held before this objection.`
        : `${how} did not hold. No verdict yet.`;
    }
    default:
      return 'Its check did not finish.';
  }
}

function technicalCheck(check: Disagreement['check']): string {
  return check
    ? `${check.id} ${check.method ? `(${check.method}) ` : ''}${check.outcome ?? check.state}.`
    : 'No check.';
}

function disagreementSub(entry: Disagreement, mode: ViewMode): string {
  const objectors = [
    ...new Set(
      entry.objections.map(({ handle, author }) => who(handle, author)),
    ),
  ];
  const answered = entry.answered
    ? `${who(entry.handle, entry.author)} answered and did not accept.`
    : '';
  if (mode === 'technical')
    return [
      `${entry.objections.map(({ post }) => post).join(', ')} ${entry.objections.length === 1 ? 'objects' : 'object'} to ${entry.post} by ${who(entry.handle, entry.author)}.`,
      answered,
      technicalCheck(entry.check),
    ]
      .filter(Boolean)
      .join(' ');
  const verb =
    objectors.length > 1 || objectors[0] === 'You' ? 'object' : 'objects';
  return [
    `${andList(objectors)} ${verb} to ${whose(entry.handle, entry.author)} post.`,
    answered,
    checkLine(entry.check),
  ]
    .filter(Boolean)
    .join(' ');
}

/** The open disagreements, the newest objection first. */
export function disagreementRows(
  page: Pick<CollabPage, 'disagreements'>,
  mode: ViewMode,
): readonly CollabRow[] {
  return page.disagreements.map((entry) => ({
    key: entry.post,
    title:
      (mode === 'simple' ? entry.thread?.plainTitle : undefined) ??
      entry.thread?.title ??
      entry.text,
    chip: { label: 'Open', tone: 'open' },
    sub: disagreementSub(entry, mode),
    to: entry.thread ? href.thread(entry.thread.id) : href.post(entry.post),
  }));
}

/** How many names the row lists. Past that, it counts. */
const namedRaisers = 5;

/** How many objections came, from whom, and how many led to an accepted change. It counts objections and no other post. */
export function objectionRow(
  page: Pick<CollabPage, 'objections' | 'handles'>,
): CollabRow {
  const { total, accepted, unanswered, by } = page.objections;
  if (!total)
    return {
      key: 'objections',
      title: 'No objections so far',
      chip: null,
      sub: 'No agent objected to a post yet.',
      to: null,
    };
  const raised = by
    .slice(0, namedRaisers)
    .map(
      ({ handle, author, count }) => `${who(handle, author)} raised ${count}`,
    );
  const rest = by.length - raised.length;
  const none = page.handles.filter(
    (handle) => !by.some((entry) => entry.handle === handle),
  );
  return {
    key: 'objections',
    title: `${total} ${total === 1 ? 'objection' : 'objections'} so far`,
    chip: { label: `${accepted} accepted`, tone: 'ok' },
    sub: [
      `${andList(raised)}${rest ? `, and ${rest} more` : ''}.`,
      ...(unanswered ? [`${unanswered} got no reply.`] : []),
      ...(none.length && none.length <= namedRaisers
        ? [`${agentsWord(none)} raised none.`]
        : none.length
          ? [`${none.length} agents raised none.`]
          : []),
    ].join(' '),
    to: null,
  };
}

function needTitle(need: Need): string {
  const from = need.waiterHandle ? roleName(need.waiterHandle) : 'You';
  const on = need.onHandle ? roleName(need.onHandle) : 'you';
  return `${from} ${need.waiterHandle ? 'needs' : 'need'} ${on}`;
}

const endedWords: Readonly<Record<NonNullable<Need['onEnded']>, string>> = {
  closed: 'Closed',
  stopped: 'Stopped',
  crashed: 'Stopped by itself',
};

function needChip(pair: readonly Need[]): Chip {
  const ended = pair.find((need) => need.onEnded)?.onEnded;
  if (ended) return { label: endedWords[ended], tone: 'done' };
  return pair.some((need) => need.on === 'person' || need.blocked)
    ? { label: 'Waits on you', tone: 'wait' }
    : { label: 'Open', tone: 'wait' };
}

/** What the pair's newest wait is about, how many more stand, and what holds them. */
function needSub(pair: readonly Need[], mode: ViewMode, now: number): string {
  const need = pair.at(-1);
  if (!need) return '';
  const subject =
    mode === 'simple' ? (need.plainSubject ?? need.subject) : need.subject;
  const why = need.reason === 'ask' ? 'Asked' : 'Objected';
  const age = `${since(need.since, now)} ago`;
  const line =
    mode === 'technical'
      ? `${why} in ${need.post}, ${age}: ${need.text}`
      : `${why} ${age}: ${subject}`;
  const stop = /[.?!]$/.test(line) ? '' : '.';
  const more = pair.length - 1;
  return [
    `${line}${stop}`,
    ...(more ? [`${more} more ${more === 1 ? 'stands' : 'stand'}.`] : []),
    ...(need.onEnded
      ? ['No reply can come until the agent works again.']
      : need.blocked
        ? ["It can't move until you decide."]
        : []),
  ].join(' ');
}

/** Who needs whom and why, one row for each pair, waits on the person first. */
export function needCollabRows(
  page: Pick<CollabPage, 'needs'>,
  mode: ViewMode,
  now: number,
): readonly CollabRow[] {
  const pairs = new Map<string, Need[]>();
  for (const need of page.needs)
    pairs.set(`${need.waiter}>${need.on}`, [
      ...(pairs.get(`${need.waiter}>${need.on}`) ?? []),
      need,
    ]);
  const rows = [...pairs].flatMap(([key, pair]): readonly CollabRow[] => {
    const need = pair.at(-1);
    return need
      ? [
          {
            key,
            title: needTitle(need),
            chip: needChip(pair),
            sub: needSub(pair, mode, now),
            to: need.thread ? href.thread(need.thread) : href.post(need.post),
          },
        ]
      : [];
  });
  const first = (row: CollabRow): number =>
    row.chip?.label === 'Waits on you' ? 0 : row.chip?.tone === 'done' ? 2 : 1;
  return [...rows].sort((a, b) => first(a) - first(b));
}

/** The queue's facts: what runs at once, what holds a pod, and the newest free time. */
function gpuLine(gpu: CollabPage['gpu'], mode: ViewMode): string {
  const { atOnce, pods, idle } = gpu;
  const free = idle
    ? `No GPU run from ${clock(idle.from)} to ${clock(idle.to)}.`
    : '';
  if (mode === 'technical')
    return [
      ...(atOnce === null ? [] : [`Pods at once: ${atOnce}.`]),
      ...(pods.length ? [`${pods.join(', ')} active.`] : []),
      ...(free ? [free] : []),
    ].join(' ');
  return [
    ...(atOnce === null
      ? []
      : [`${atOnce} ${atOnce === 1 ? 'GPU' : 'GPUs'} at a time.`]),
    ...(free ? [free] : []),
  ].join(' ');
}

/** The GPU queue: each run that waits, and each pod that waits for the person. With no queue, one row says what runs. */
export function gpuRows(
  page: Pick<CollabPage, 'gpu'>,
  mode: ViewMode,
): readonly CollabRow[] {
  const { gpu } = page;
  const line = gpuLine(gpu, mode);
  const [running] = gpu.running;
  const queued = gpu.queued.map(
    (run): CollabRow => ({
      key: run.run,
      title: `${who(run.handle)} ${run.handle ? 'needs' : 'need'} the GPU`,
      chip: {
        label: running ? `Behind ${who(running.handle)}` : 'Queued',
        tone: 'wait',
      },
      sub:
        mode === 'technical'
          ? `${run.run} queued ${clock(run.since)}. ${line}`.trim()
          : line,
      to: href.runPage(run.run),
    }),
  );
  const requested = gpu.requested.map(
    (pod): CollabRow => ({
      key: pod.lease,
      title: 'A pod waits for you',
      chip: { label: 'Waits on you', tone: 'wait' },
      sub:
        mode === 'technical'
          ? `${pod.lease} requested ${clock(pod.at)}. ${line}`.trim()
          : line,
      to: href.settings,
    }),
  );
  if (queued.length || requested.length) return [...requested, ...queued];
  return running || gpu.pods.length
    ? [
        {
          key: 'gpu',
          title: 'No agent waits for the GPU',
          chip: running
            ? { label: `${who(running.handle)} runs`, tone: 'run' }
            : null,
          sub: line,
          to: running ? href.runPage(running.run) : null,
        },
      ]
    : [];
}
