import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Workspace } from './contracts.ts';
import { listArchives } from './archive.ts';
import { ResultsStore, type Results } from './results.ts';
import { loadWorkspace } from './storage.ts';
import type { TaskRecord } from './tasks.ts';
import { hostName } from './session.ts';

/**
 * The project memory: plain Markdown files in `memory/` that the person and
 * the agents can read. Verifold writes its part of each file from its records,
 * between markers, and keeps the rest, so the person's own text stays. Notes
 * from the agents are added, never rewritten. Before Start over archives a
 * run, its progress, decisions, and findings stay in the files as an earlier
 * run, so a new run and a restarted agent can continue from them.
 */

const files = {
  readme: {
    path: 'README.md',
    title: 'Project memory',
    about:
      'Read this first. It says what this project asks, what was done, decided, and found, also in earlier runs. The other files hold the details.',
  },
  direction: {
    path: 'direction.md',
    title: 'Direction',
    about:
      'The direction that this project follows, and the checks that decide its answer. A task that needs this specification gets this file as an input.',
  },
  progress: {
    path: 'progress.md',
    title: 'Progress',
    about: 'What is done, what runs, and what comes next.',
  },
  decisions: {
    path: 'decisions.md',
    title: 'Decisions',
    about: 'Who decided what, and when.',
  },
  findings: {
    path: 'findings.md',
    title: 'Findings',
    about: 'The results of the checks, with their evidence, and the answer.',
  },
  notes: {
    path: 'notes.md',
    title: 'Notes',
    about:
      'Notes that the agents keep for later runs: a decision, a dead end, or a fact that the next agent needs.',
  },
} as const;

type Part = keyof typeof files;

/** The notes that a file keeps. Older ones drop out. */
const noteLimit = 300;

function begin(name: string): string {
  return `<!-- verifold:${name} -->`;
}

function end(name: string): string {
  return `<!-- /verifold:${name} -->`;
}

/** A new file: a title, what it holds, a line for the person, and Verifold's part. */
function template(part: Part): string {
  const file = files[part];
  return `# ${file.title}\n\n${file.about} Verifold keeps the part between its markers up to date. Write your own notes outside them.\n\n${begin(part)}\n${end(part)}\n`;
}

/** The text between the markers of a part, or null without markers. */
function section(text: string, name: string): string | null {
  const from = text.indexOf(begin(name));
  const to = text.indexOf(end(name));
  return from < 0 || to < from
    ? null
    : text.slice(from + begin(name).length, to).trim();
}

/** The text with a new body between the markers. Without markers, the part goes at the end. */
function replace(text: string, name: string, body: string): string {
  const from = text.indexOf(begin(name));
  const to = text.indexOf(end(name));
  const block = `${begin(name)}\n${body.trim()}\n${end(name)}`;
  return from < 0 || to < from
    ? `${text.trimEnd()}\n\n${block}\n`
    : `${text.slice(0, from)}${block}${text.slice(to + end(name).length)}`;
}

function day(at: string): string {
  return at.slice(0, 16).replace('T', ' ');
}

/** A file name for a task: its creation day and its title. */
function slug(task: TaskRecord): string {
  const title = task.assignment.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${task.createdAt.slice(0, 10)}-${title || task.id}.md`;
}

function line(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** What the memory keeps of a lab: each direction with its verdict and its evidence, open ones first. */
export type LabProgress = readonly {
  readonly id: string;
  readonly title: string;
  readonly open: boolean;
  /** In words, such as "open" or "stopped by the person". */
  readonly state: string;
  /** Its agent's handle and harness, such as "claude-1 (Claude Code)". */
  readonly agent: string | null;
  readonly bar: string | null;
  /** In words, such as "leading" or "no verdict yet". */
  readonly verdict: string;
  readonly evidence: {
    readonly text: string;
    readonly post: string;
    readonly run: string | null;
  } | null;
}[];

interface State {
  readonly workspace: Workspace;
  readonly tasks: readonly TaskRecord[];
  readonly results: Results | null;
  readonly archived: number;
  readonly lab: LabProgress | null;
}

/** The lab's directions with their verdicts and evidence. */
function labProgress(lab: LabProgress): string {
  return `## Lab directions\n\n${
    lab
      .map(
        (direction) =>
          `- ${direction.id} ${line(direction.title, 120)}${direction.agent ? `, ${direction.agent}` : ''}: ${direction.open ? '' : `${direction.state}, `}${direction.verdict}.${direction.evidence ? ` Evidence: ${line(direction.evidence.text, 120)} (${direction.evidence.post}${direction.evidence.run ? `, ${direction.evidence.run}` : ''}).` : ''}${direction.bar ? ` Holds up if: ${line(direction.bar, 300)}.` : ''}`,
      )
      .join('\n') || 'No direction yet.'
  }\n`;
}

function progress({ tasks, lab }: State): string {
  const group = (
    title: string,
    list: readonly TaskRecord[],
    show: (task: TaskRecord) => string,
  ): string =>
    list.length ? `## ${title}\n\n${list.map(show).join('\n')}\n` : '';
  const done = tasks.filter((task) => task.state === 'done');
  const working = tasks.filter((task) =>
    ['claimed', 'running', 'review'].includes(task.state),
  );
  const waiting = tasks.filter((task) => task.state === 'open');
  return (
    [
      lab ? labProgress(lab) : '',
      group('Done', done, (task) => {
        const artifact = task.artifacts?.at(-1);
        return `- ${task.assignment.title} (${task.id}), ${hostName(task.assignment.host)}. Accepted ${artifact ? `${day(artifact.at)}: ${artifact.files.map((file) => file.path).join(', ') || 'no files'}` : ''}. Details: tasks/${slug(task)}`;
      }),
      group(
        'Working',
        working,
        (task) =>
          `- ${task.assignment.title} (${task.id}), ${hostName(task.assignment.host)}: ${task.state === 'review' ? 'a version waits for review' : 'its agent works'}.`,
      ),
      group(
        'Next',
        waiting,
        (task) =>
          `- ${task.assignment.title} (${task.id})${task.assignment.draft ? ', a draft for the person' : ''}${task.assignment.dependencies.length ? `, waits for ${task.assignment.dependencies.join(', ')}` : ''}.`,
      ),
    ]
      .filter(Boolean)
      .join('\n') || 'No tasks yet.'
  );
}

function decisions({ workspace, tasks, results }: State): string {
  const entries: { at: string; text: string }[] = [];
  const idea = workspace.candidates.find(
    (candidate) => candidate.id === workspace.selectedId,
  );
  for (const task of tasks)
    for (const attempt of task.attempts)
      for (const version of attempt.versions) {
        const decision = version.decision;
        if (!decision) continue;
        const who =
          decision.by === 'coordinator' ? 'The coordinator' : 'The person';
        const what =
          decision.kind === 'accepted'
            ? `accepted version ${version.number} of ${task.assignment.title}: ${decision.files?.join(', ') ?? ''}`
            : decision.kind === 'changes'
              ? `asked ${task.assignment.title} for changes to version ${version.number}`
              : `rejected version ${version.number} of ${task.assignment.title}`;
        entries.push({
          at: decision.at,
          text: `${who} ${what}${decision.note ? `: ${line(decision.note, 200)}` : ''}.`,
        });
      }
  for (const entry of results?.checks ?? [])
    if (entry.ruling)
      entries.push({
        at: entry.ruling.at,
        text: `The person ruled on check ${entry.check}: ${entry.ruling.result}. ${line(entry.ruling.reason, 200)}`,
      });
  const answer = results?.answer?.decision;
  if (answer)
    entries.push({
      at: answer.at,
      text:
        answer.kind === 'accepted'
          ? 'The person accepted the answer.'
          : `The person asked for more work${answer.note ? `: ${line(answer.note, 200)}` : ''}.`,
    });
  return [
    idea
      ? `Chosen direction: ${idea.title}. ${line(idea.recommendation, 300)}`
      : 'No direction is chosen yet.',
    '',
    ...entries
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((entry) => `- ${day(entry.at)}: ${entry.text}`),
  ].join('\n');
}

function findings({ workspace, results }: State): string {
  const idea = workspace.candidates.find(
    (candidate) => candidate.id === workspace.selectedId,
  );
  if (!idea) return 'No direction is chosen yet, so no check has a result.';
  const own = results?.direction === idea.id ? results : null;
  const checks = idea.gates.map((gate, index) => {
    const entry = own?.checks.find((saved) => saved.check === index + 1);
    const result = entry?.ruling?.result ?? entry?.result;
    return `- Check ${index + 1}: ${gate}\n  - Result: ${result ?? 'not reported yet'}${entry ? `. ${line(entry.value, 300)}${entry.evidence.length ? ` Evidence: ${entry.evidence.join(', ')}.` : ''}` : ''}`;
  });
  const answer = own?.answer;
  return [
    `Direction: ${idea.title}`,
    '',
    ...checks,
    '',
    answer
      ? `Answer (${answer.decision?.kind === 'accepted' ? 'accepted by the person' : 'waits for the person'}): ${line(answer.statement, 600)}\n${answer.claims.map((claim) => `- ${line(claim.text, 300)} Evidence: ${claim.evidence.join(', ')}.`).join('\n')}`
      : 'No answer yet.',
  ].join('\n');
}

function taskFile(task: TaskRecord): string {
  const versions = task.attempts.flatMap((attempt) => attempt.versions);
  return [
    `Task ${task.id}, revision ${task.revision}: ${task.state}. ${hostName(task.assignment.host)}.`,
    '',
    `Objective: ${line(task.assignment.objective, 1200)}`,
    `Expected output: ${line(task.assignment.output, 400)}`,
    `May write to: ${task.assignment.writable.join(', ')}`,
    task.assignment.dependencies.length
      ? `Waits for: ${task.assignment.dependencies.join(', ')}`
      : '',
    '',
    ...versions.map(
      (version) =>
        `- Version ${version.number}, ${day(version.at)}: ${version.files.map((file) => file.path).join(', ') || 'no files'}.${version.decision ? ` ${{ accepted: 'Accepted', changes: 'Changes asked', rejected: 'Rejected' }[version.decision.kind]}${version.decision.by === 'coordinator' ? ' by the coordinator' : ''}.` : ''}${version.reply ? ` The agent said: ${line(version.reply, 400)}` : ''}`,
    ),
  ]
    .filter((entry, index, all) => entry || all[index - 1])
    .join('\n');
}

function direction({ workspace }: State): string {
  const idea = workspace.candidates.find(
    (candidate) => candidate.id === workspace.selectedId,
  );
  return idea
    ? [
        `Direction: ${idea.title}`,
        '',
        idea.recommendation.trim(),
        '',
        'Checks:',
        ...idea.gates.map((gate, index) => `${index + 1}. ${gate}`),
      ].join('\n')
    : 'No direction is chosen yet.';
}

function readme(state: State, notes: readonly string[]): string {
  const { workspace, tasks, archived, lab } = state;
  const idea = workspace.candidates.find(
    (candidate) => candidate.id === workspace.selectedId,
  );
  const done = tasks.filter((task) => task.state === 'done').length;
  return [
    `Question: ${workspace.research?.topic ?? 'not asked yet'}`,
    idea ? `Direction: ${idea.title}` : 'Direction: not chosen yet',
    `This run: ${lab ? `a lab with ${lab.length} ${lab.length === 1 ? 'direction' : 'directions'}, ${lab.filter((direction) => direction.open).length} open; progress.md lists them with their verdicts.` : `${tasks.length} tasks, ${done} done.`}${archived ? ` ${archived} earlier ${archived === 1 ? 'run is' : 'runs are'} archived; their progress, decisions, and findings are in the files below.` : ''}`,
    '',
    '- direction.md: the chosen direction and its checks.',
    '- progress.md: what is done, what runs, and what comes next.',
    '- decisions.md: who decided what, and when.',
    '- findings.md: the check results with their evidence, and the answer.',
    '- notes.md: notes from the agents.',
    '- tasks/: one file for each task.',
    ...(notes.length ? ['', 'Latest notes:', ...notes.slice(-5)] : []),
  ].join('\n');
}

/** Write a file only when its text changes, through a temporary file. */
async function save(path: string, text: string): Promise<void> {
  const before = await readFile(path, 'utf8').catch(() => null);
  if (before === text) return;
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class ProjectMemory {
  private readonly root: string;
  private readonly tasks: () => Promise<readonly TaskRecord[]>;
  private readonly lab: () => LabProgress | null;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    root: string,
    tasks: () => Promise<readonly TaskRecord[]>,
    lab: () => LabProgress | null = () => null,
  ) {
    this.root = root;
    this.tasks = tasks;
    this.lab = lab;
  }

  private get folder(): string {
    return join(this.root, 'memory');
  }

  /** Run one change after the previous one ends. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Write the files soon. Changes that come close together make one write. */
  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write().catch(() => {
        /* The next change writes again. */
      });
    }, 1500);
    this.timer.unref();
  }

  /** The text of one file, or its template when it does not exist. A link or a folder in its place is refused. */
  private async read(part: Part): Promise<string> {
    const path = join(this.folder, files[part].path);
    const stats = await lstat(path).catch(() => null);
    if (stats && !stats.isFile())
      throw new Error(`memory/${files[part].path} must be a regular file.`);
    return stats ? readFile(path, 'utf8') : template(part);
  }

  private async state(): Promise<State> {
    const store = new ResultsStore(this.root);
    await store.load();
    return {
      workspace: await loadWorkspace(this.root),
      tasks: await this.tasks(),
      results: store.current(),
      archived: (await listArchives(this.root)).length,
      lab: this.lab(),
    };
  }

  /** Rewrite Verifold's part of each file from the records. */
  write(): Promise<void> {
    return this.serial(async () => {
      const folder = await lstat(this.folder).catch(() => null);
      if (folder && !folder.isDirectory())
        throw new Error('memory must be a folder.');
      await mkdir(join(this.folder, 'tasks'), { recursive: true });
      const state = await this.state();
      const notes = (section(await this.read('notes'), 'notes') ?? '')
        .split('\n')
        .filter((entry) => entry.startsWith('- '));
      const bodies: Record<Exclude<Part, 'notes'>, string> = {
        readme: readme(state, notes),
        direction: direction(state),
        progress: progress(state),
        decisions: decisions(state),
        findings: findings(state),
      };
      for (const [part, body] of Object.entries(bodies) as [
        Exclude<Part, 'notes'>,
        string,
      ][])
        await save(
          join(this.folder, files[part].path),
          replace(await this.read(part), part, body),
        );
      await save(
        join(this.folder, files.notes.path),
        replace(
          await this.read('notes'),
          'notes',
          notes.join('\n') || 'No notes yet.',
        ),
      );
      for (const task of state.tasks) {
        const path = join(this.folder, 'tasks', slug(task));
        const before = await readFile(path, 'utf8').catch(
          () =>
            `# ${task.assignment.title}\n\nVerifold keeps the part between its markers up to date. Write your own notes outside them.\n\n${begin('task')}\n${end('task')}\n`,
        );
        await save(path, replace(before, 'task', taskFile(task)));
      }
    });
  }

  /** Add a note from an agent. `who` is the coordinator or a task title. */
  note(who: string, text: unknown): Promise<string> {
    return this.serial(async () => {
      if (typeof text !== 'string' || !text.trim() || text.length > 2000)
        throw new Error('Write the note, up to 2000 characters.');
      await mkdir(this.folder, { recursive: true });
      const current = await this.read('notes');
      const notes = (section(current, 'notes') ?? '')
        .split('\n')
        .filter((entry) => entry.startsWith('- '));
      const entry = `- ${day(new Date().toISOString())}, ${line(who, 120)}: ${line(text, 2000)}`;
      await save(
        join(this.folder, files.notes.path),
        replace(
          current,
          'notes',
          [...notes, entry].slice(-noteLimit).join('\n'),
        ),
      );
      this.schedule();
      return 'Kept the note in memory/notes.md.';
    });
  }

  /**
   * Before Start over archives the run: its progress, decisions, and findings
   * stay in the files, above Verifold's part, as an earlier run.
   */
  freeze(label: string): Promise<void> {
    return this.serial(async () => {
      for (const part of ['progress', 'decisions', 'findings'] as const) {
        const path = join(this.folder, files[part].path);
        const text = await readFile(path, 'utf8').catch(() => null);
        const body = text === null ? null : section(text, part);
        if (text === null || !body || /^No (tasks|direction)/.test(body))
          continue;
        await save(
          path,
          text.replace(
            begin(part),
            `## Earlier run, ${label}\n\n${body}\n\n${begin(part)}`,
          ),
        );
      }
    });
  }

  /** The index for an agent's prompt: memory/README.md, up to `limit` characters. Empty without memory. */
  async digest(limit = 6000): Promise<string> {
    const text = await readFile(
      join(this.folder, files.readme.path),
      'utf8',
    ).catch(() => '');
    return text.length > limit
      ? `${text.slice(0, limit)}\n[Verifold: memory/README.md continues.]`
      : text;
  }
}
