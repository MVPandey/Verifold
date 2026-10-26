/**
 * Pure helpers of the lab: text for agents and the person, and decisions that
 * read records only, such as a call's askers or whether a file may come in.
 * Nothing here holds state.
 */
import { createHash } from 'node:crypto';
import {
  boardLimits,
  clip,
  safePath,
  type NewPost,
  type Post,
  type PostKind,
} from '../board.ts';
import { type SessionRecord, usdValue } from '../session.ts';
import {
  type ChangedFile,
  scratch,
  limits as workspaceLimits,
} from '../workspaces.ts';
import {
  type Brought,
  type Call,
  type Direction,
  type Evidence,
  type LabEvent,
  type LabState,
  type LabView,
  type PlanFact,
  type Spend,
  type Verdict,
  chosenEffect,
  labLimits,
  stands,
} from './schema.ts';

/**
 * Add what a session spent since the agent last looked to what the agent
 * spent. Claude Code's estimate covers the whole session, also after a
 * resume, so it only grows. An agent's new session starts from zero.
 * Returns `prior` itself when nothing changed.
 */
export function addSpend(
  prior: Spend | undefined,
  record: SessionRecord,
): Spend | undefined {
  const total = record.costUsd;
  if (total === null || !usdValue(total)) return prior;
  const same = prior?.session === record.id;
  if (same && total <= prior.seen) return prior;
  return {
    usd: (prior?.usd ?? 0) + total - (same ? prior.seen : 0),
    session: record.id,
    seen: total,
  };
}

/**
 * The event holds the person's own words: their post, or their answer to a
 * call. It wakes the agent past its hourly turns, and that turn does not
 * count.
 */
export function personal(event: LabEvent): boolean {
  return event.kind === 'person' || event.byPerson === true;
}

/** The agents that asked a call: the first, then those that joined. Verifold's own call has none. */
export function askers(call: Call): string[] {
  return [
    ...(call.by === 'verifold' ? [] : [call.by]),
    ...call.joined.map((asker) => asker.agent),
  ];
}

/** The directions of the agents that asked a call, in the order of `askers`. Verifold's own call has none. */
export function askerDirections(call: Call): (string | null)[] {
  return [
    ...(call.by === 'verifold' ? [] : [call.direction]),
    ...call.joined.map((asker) => asker.direction),
  ];
}

/** A status line from Verifold on a call, in the call's direction. */
export function callStatus(call: Call, text: string): NewPost {
  return {
    author: 'verifold',
    kind: 'status',
    ...(call.direction ? { direction: call.direction } : {}),
    text: clip(text, boardLimits.text),
    mentions: [],
    artifacts: [],
  };
}

/** The board's record of an answer in the person's words: a reply in the call's thread, else a status line. */
export function wordsPost(call: Call, words: string): NewPost {
  return call.post
    ? {
        author: 'person',
        kind: 'question',
        replyTo: call.post,
        text: words,
        mentions: [],
        artifacts: [],
      }
    : callStatus(
        call,
        `The person answered ${call.id} in their own words: ${JSON.stringify(words)}`,
      );
}

/** What the agents that asked hear about an answer in the person's words. */
export function wordsLine(call: Call, words: string): string {
  return `The person answered ${call.id} in their own words, so no option applies: ${JSON.stringify(words)}. This is their decision: follow it, or ask again with new options when it is unclear.`;
}

/**
 * Two calls ask for the same thing: the same kind, the same need, and the
 * same effects, with domains compared as sets. A pod is for one direction,
 * so a call with a pod joins no other. A call with no need and no effect
 * says nothing that Verifold can compare, so it joins none either.
 */
export function sameAsk(
  a: Pick<Call, 'kind' | 'need' | 'options'>,
  b: Pick<Call, 'kind' | 'need' | 'options'>,
): boolean {
  const effects = (call: typeof a): string[] | null => {
    const list = call.options.flatMap((option) =>
      option.effect ? [option.effect] : [],
    );
    return list.some((effect) => effect.type === 'pod')
      ? null
      : list
          .map((effect) =>
            JSON.stringify(
              effect.type === 'domains'
                ? { ...effect, domains: [...effect.domains].sort() }
                : effect,
            ),
          )
          .sort();
  };
  const [first, second] = [effects(a), effects(b)];
  if (a.kind !== b.kind || a.need !== b.need || !first || !second) return false;
  return (
    (a.need !== null || first.length > 0) &&
    first.join('\n') === second.join('\n')
  );
}

/** The person approved a GPU pod in an answer that stands. Until then, each pod request of an agent is a call. */
export function gpuApproved(state: LabState): boolean {
  return state.calls.some(
    (call) => stands(call) && call.applied?.type === 'pod',
  );
}

/**
 * The domains that an agent's shell reaches: those of its access answers
 * that stand. A lab agent starts with none. Each start reads them, so no
 * other copy can go stale.
 */
export function networkOf(state: LabState, agent: string): string[] {
  return [
    ...new Set(
      state.calls.flatMap((call) => {
        const effect = chosenEffect(call);
        return askers(call).includes(agent) &&
          stands(call) &&
          call.applied?.type === 'domains' &&
          effect?.type === 'domains'
          ? effect.domains
          : [];
      }),
    ),
  ].sort();
}

/** A file's text for an agent: a binary file says its size, and a long one is cut. */
export function fileText(path: string, content: Buffer): string {
  const size = content.length;
  if (content.subarray(0, 8000).includes(0))
    return `${path} is a binary file of ${size} bytes.`;
  if (size <= labLimits.readBytes) return content.toString('utf8');
  // The cut goes between characters: a byte from 0x80 to 0xbf continues the character before it.
  let end = labLimits.readBytes;
  while (end > 0 && ((content[end] ?? 0) & 0xc0) === 0x80) end--;
  return `${content.subarray(0, end).toString('utf8')}\n[Verifold: the file continues. It has ${size} bytes.]`;
}

/** The note on files that stayed out of a run's commit. */
export function linkedText(linked: readonly string[]): string {
  return linked.length
    ? ` Files with more than one hard link stayed out of the commit, so the run does not have them: ${linked.slice(0, 5).join(', ')}.`
    : '';
}

/** What an agent hears of the files with more than one link that the commit after its turn left out. */
export function linkedNote(paths: readonly string[], count: number): string {
  return `Verifold left files with more than one hard link out of your commit, so other agents cannot read them: ${paths.join(', ')}${count > paths.length ? ', and more' : ''}. Write separate copies instead.`;
}

export const stoppedText =
  'This session no longer works for the lab, so Verifold did nothing.';

export const movingText =
  'Verifold is moving the lab to the archive. Try again in a moment.';

export const bringStoppedText =
  'Nothing came in: Start over stopped the bring-in.';

/**
 * The bring-ins with the files of `record` that came in: each file of a
 * direction keeps only its newest base. Without files, the same list.
 */
export function withBrought(
  list: readonly Brought[],
  record: { readonly direction: string; readonly commit: string },
  done: readonly string[],
): readonly Brought[] {
  if (!done.length) return list;
  const at = new Date().toISOString();
  const now = new Set(done);
  return [
    ...list.filter(
      (entry) => entry.direction !== record.direction || !now.has(entry.path),
    ),
    ...done.map((path) => ({
      direction: record.direction,
      path,
      commit: record.commit,
      at,
    })),
  ];
}

/** One bring-in of a direction: when, at which commit, and the files that keep it as their base. */
export interface BringGroup {
  readonly at: string;
  readonly commit: string;
  readonly paths: readonly string[];
}

/**
 * A direction's bring-ins, oldest first: the files that keep each one as
 * their base, by its time and commit. A file that came in again counts only
 * with its newest bring-in.
 */
export function bringGroups(
  brought: readonly Brought[],
  direction: string,
): BringGroup[] {
  const groups = new Map<
    string,
    { readonly at: string; readonly commit: string; readonly paths: string[] }
  >();
  for (const entry of brought) {
    if (entry.direction !== direction) continue;
    const key = `${entry.at}|${entry.commit}`;
    const group = groups.get(key) ?? {
      at: entry.at,
      commit: entry.commit,
      paths: [],
    };
    group.paths.push(entry.path);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  );
}

/** A direction's bar with its repeat runs and its noise, such as "it beats SAE · 3 runs · noise ±0.02". */
export function barSummary(direction: Direction): string {
  return [
    direction.bar ?? '',
    direction.runs ? counted(direction.runs, 'run') : '',
    direction.noise ? `noise ${direction.noise}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The bar for a prompt or a digest: an agent wrote it, so it is quoted. */
export function barText(direction: Direction): string {
  return direction.bar ? JSON.stringify(barSummary(direction)) : 'not set';
}

/** A direction's verdict in words, such as "leading", or "no verdict yet". */
export function verdictWord(direction: Direction): string {
  return direction.verdict === 'open'
    ? 'no verdict yet'
    : verdictWords[direction.verdict].toLowerCase();
}

/** A direction's state in words: open, closed by its agent, or stopped by the person. */
export function stateWord(direction: Direction): string {
  return direction.state === 'open'
    ? 'open'
    : direction.state === 'closed'
      ? 'closed by its agent'
      : 'stopped by the person';
}

/** A direction's state and verdict for a prompt or a digest, such as "open, leading: "61.2 vs 57.1" (p-14, r-6)". */
export function verdictLine(direction: Direction): string {
  return `${stateWord(direction)}, ${verdictWord(direction)}${direction.evidence ? `: ${evidenceText(direction.evidence)}` : ''}`;
}

/**
 * Today's date, time, and time zone on this computer. An agent's training
 * data ends before today, so each prompt and digest states it.
 */
export function todayLine(now = new Date()): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return `Today is ${localDay(now)} (${now.toLocaleDateString('en-US', { weekday: 'long' })}), ${two(now.getHours())}:${two(now.getMinutes())} in the time zone ${zone}.`;
}

/** A date as YYYY-MM-DD in this computer's time zone, the zone of `todayLine`. */
export function localDay(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** A plan's facts as prompt lines. Their texts come from an agent, so they are quoted. */
export function factLines(facts: readonly PlanFact[]): string[] {
  return facts.map(
    (fact) =>
      `- ${JSON.stringify(fact.claim)}: ${fact.source ? `source ${JSON.stringify(fact.source)}${fact.sourceDate ? ` of ${JSON.stringify(fact.sourceDate)}` : ''}, listed ${localDay(new Date(fact.checkedAt))}` : 'unverified (no source)'}.`,
  );
}

/**
 * The GPU pods of a lab. `none`: this Verifold has no pods, so no setting
 * turns them on. `on`: a RunPod key is saved and the person set a spend
 * limit. Otherwise pods are off, without a spend limit or without a key.
 */
export type PodsState = 'none' | 'on' | 'no-limit' | 'no-key';

/**
 * What an agent reads of each pods state: the line of its prompts, why a pod
 * request starts no pod, and the access call that turns pods on, where the
 * person can turn them on.
 */
export const podsWords = {
  none: {
    line: 'GPU pods: this Verifold has none.',
    off: 'GPUs are not available here: this Verifold has no GPU pods, and the person cannot turn them on. Do the work without a GPU, or post on the board why it needs one.',
    call: null,
  },
  on: {
    line: 'GPU pods: on. A RunPod key is saved, and the person set a spend limit.',
    off: null,
    call: null,
  },
  'no-limit': {
    line: "GPU pods: off. A RunPod key is saved, but the person set no spend limit in the project's settings yet.",
    off: "Pods are off: a RunPod key is saved, but the person set no spend limit in the project's settings.",
    call: {
      question:
        "Set a spend limit in the project's settings, so agents can rent GPUs?",
      done: 'I set a limit',
    },
  },
  'no-key': {
    line: 'GPU pods: off. No RunPod key is saved yet.',
    off: 'Pods are off: no RunPod key is saved, and no spend limit is set.',
    call: {
      question: 'Add a RunPod key and a spend limit, so agents can rent GPUs?',
      done: 'I added them',
    },
  },
} as const satisfies Record<
  PodsState,
  {
    readonly line: string;
    readonly off: string | null;
    readonly call: { readonly question: string; readonly done: string } | null;
  }
>;

/** The words of each verdict. */
export const verdictWords: Record<Verdict, string> = {
  open: 'Open',
  leading: 'Leading',
  'holds-up': 'Holds up',
  'ruled-out': 'Ruled out',
};

/** A verdict's evidence in one line, such as "61.2 vs 57.1" (p-14, r-6). Its text comes from an agent, so it is quoted. */
export function evidenceText(evidence: Evidence): string {
  return `${JSON.stringify(evidence.text)} (${evidence.post}${evidence.run ? `, ${evidence.run}` : ''})`;
}

/** The lab's time budget ended. */
export function budgetEnded(state: LabState, now = Date.now()): boolean {
  return state.budget !== null && Date.parse(state.budget.deadline) <= now;
}

/**
 * Why the lab ended, or null while it works: every direction closed or
 * stopped, or the person chose to stop at the end of the time budget.
 */
export function labEnded(
  state: LabState,
  now = Date.now(),
): 'directions' | 'budget' | null {
  if (
    state.directions.length &&
    state.directions.every((direction) => direction.state !== 'open')
  )
    return 'directions';
  if (!budgetEnded(state, now)) return null;
  const last = state.calls
    .filter((call) => call.deadline === state.budget?.deadline)
    .at(-1);
  return last?.state === 'answered' &&
    last.answer &&
    !last.options[last.answer.option]?.effect
    ? 'budget'
    : null;
}

/**
 * Why a changed file cannot come into the project folder, or null. `after`
 * is the file at the commit, when it has one. The names compare in
 * lowercase, because a Mac's folders do.
 */
export function bringOut(
  path: string,
  after: { readonly mode: string; readonly bytes: number } | undefined,
  change: ChangedFile['change'],
): string | null {
  const parts = path.toLowerCase().split('/');
  if (!safePath(path))
    return 'Its name is too long, or has characters that Verifold does not copy.';
  if (parts[0] === '.verifold') return "Verifold's own records stay out.";
  if (parts.includes('.git')) return "Git's own data stays out.";
  if (
    change !== 'deleted' &&
    after?.mode !== '100644' &&
    after?.mode !== '100755'
  )
    return 'It is a link or a submodule, not a file.';
  if ((after?.bytes ?? 0) > workspaceLimits.fileBytes)
    return `It is larger than ${workspaceLimits.fileBytes / 1024 / 1024} MB.`;
  return null;
}

/**
 * Why a file that can come in is not ticked first, or null. Project memory,
 * scratch output, and settings that run code wait for the person to tick
 * them.
 */
export function untickReason(path: string): string | null {
  if (path.split('/')[0]?.toLowerCase() === 'memory')
    return 'Project memory, so not ticked.';
  if (scratch(path)) return 'Scratch output, so not ticked.';
  if (codeSetting(path))
    return 'It can run code through your tools, such as a Git hook or an editor task. Check its diff first.';
  return null;
}

/**
 * Folders, at any depth, of settings that tools run as code: Git hooks,
 * agent and editor settings, and dev containers.
 */
const codeFolders = new Set([
  '.githooks',
  '.git-hooks',
  '.git_hooks',
  '.husky',
  '.lefthook',
  '.claude',
  '.codex',
  '.cursor',
  '.vscode',
  '.idea',
  '.zed',
  '.devcontainer',
]);

/** Files, at any depth, that tools run as code or use to start code. */
const codeFiles = new Set([
  '.mcp.json',
  '.envrc',
  '.pre-commit-config.yaml',
  '.pre-commit-hooks.yaml',
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.gitlab-ci.yml',
]);

/**
 * A path that tools run as code: a file in a folder of such settings, a
 * file of such settings, or a GitHub workflow or action. Each part
 * compares in lowercase.
 */
export function codeSetting(path: string): boolean {
  const parts = path.toLowerCase().split('/');
  const name = parts.at(-1) ?? '';
  return (
    parts.slice(0, -1).some((part) => codeFolders.has(part)) ||
    codeFiles.has(name) ||
    parts.some(
      (part, index) =>
        part === '.github' &&
        (parts[index + 1] === 'workflows' || parts[index + 1] === 'actions'),
    )
  );
}

/** The ID that Git gives this content as a blob, in the hash of `like`, an ID of the same repository: SHA-256 when it has 64 digits. */
function blobId(content: Buffer, like: string): string {
  return createHash(like.length === 64 ? 'sha256' : 'sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}

/**
 * A project file is this file of a commit: both missing, or the same Git
 * mode and blob ID. A project path that is no file matches nothing.
 */
export function sameFile(
  now: { readonly content: Buffer; readonly mode: string } | null | undefined,
  entry: { readonly mode: string; readonly id: string } | undefined,
  like: string,
): boolean {
  if (now === undefined) return false;
  if (now === null || !entry) return now === null && !entry;
  return now.mode === entry.mode && blobId(now.content, like) === entry.id;
}

/** File names for a message: the first 10, then how many more. */
export function nameList(paths: readonly string[]): string {
  return `${paths.slice(0, 10).join(', ')}${paths.length > 10 ? `, and ${paths.length - 10} more` : ''}`;
}

/** The folder name of a direction: its ID and a short form of its title. */
export function slug(id: string, title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return words ? `${id}-${words}` : id;
}

/**
 * The lab's words for its posts, calls, and authors. The desk and the API
 * show them, and search matches on them, so the person finds a post by the
 * word that it shows.
 */
export const kindWords: Record<PostKind, string> = {
  plan: 'Plan of record',
  claim: 'Claim',
  evidence: 'Evidence',
  objection: 'Objection',
  question: 'Question',
  rerun: 'Rerun',
  'ruled-out': 'Ruled out',
  status: 'Note',
};

/** A post's kind in words. The person's question is a message. */
export function kindLabel(post: Post): string {
  return post.author === 'person' && post.kind === 'question'
    ? 'Message'
    : kindWords[post.kind];
}

export const callWords = {
  cost: 'Cost call',
  scope: 'Scope call',
  access: 'Access call',
  go: 'Go call',
} as const;

/** Who wrote a post or asked a call, in the lab's words. */
export function authorName(view: LabView, author: string): string {
  return author === 'person'
    ? 'You'
    : author === 'verifold'
      ? 'Verifold'
      : (view.handles[author] ?? author);
}

/** A direction's verdict in words. A direction with no verdict is not settled yet. */
export function verdictText(verdict: Verdict, disputed: boolean): string {
  return disputed
    ? 'Disputed'
    : verdict === 'open'
      ? 'Not settled'
      : verdictWords[verdict];
}

/** A count with its noun, such as "1 post" or "4 posts". */
export function counted(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}
