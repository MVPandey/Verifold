/**
 * Pure helpers of the lab: text for agents and the person, and decisions that
 * read records only, such as a call's askers or whether a file may come in.
 * Nothing here holds state.
 */
import { createHash } from 'node:crypto';
import { safePath } from '../board.ts';
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
  type LabState,
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

/** The agents that asked a call: the first, then those that joined. Verifold's own call has none. */
export function askers(call: Call): string[] {
  return [
    ...(call.by === 'verifold' ? [] : [call.by]),
    ...call.joined.map((asker) => asker.agent),
  ];
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
  return size > labLimits.readBytes
    ? `${content.subarray(0, labLimits.readBytes).toString('utf8')}\n[Verifold: the file continues. It has ${size} bytes.]`
    : content.toString('utf8');
}

/** The note on files that stayed out of a run's commit. */
export function linkedText(linked: readonly string[]): string {
  return linked.length
    ? ` Files with more than one hard link stayed out of the commit, so the run does not have them: ${linked.slice(0, 5).join(', ')}.`
    : '';
}

export const stoppedText =
  'This session no longer works for the lab, so Verifold did nothing.';

export const movingText =
  'Verifold is moving the lab to the archive. Try again in a moment.';

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
    direction.runs
      ? `${direction.runs} ${direction.runs === 1 ? 'run' : 'runs'}`
      : '',
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
