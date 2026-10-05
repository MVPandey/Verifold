import { loadPrompt } from './prompts.ts';
import {
  mkdir,
  open,
  readdir,
  writeFile,
  rm,
  lstat,
  rename,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CliIO } from './commands.ts';
import { withActivity } from './choices.ts';
import { parseCandidates } from './contracts.ts';
import type { Candidate, Workspace } from './contracts.ts';
import { activityProgress, runHarness, type HarnessResult } from './harness.ts';
import { TranscriptWriter } from './transcript.ts';
import { changeWorkspace, loadWorkspace, readJson } from './storage.ts';
import { processStart, stopRecordedProcess } from './owner.ts';
import {
  object,
  text,
  sourceUrl,
  parseHostJson,
  parseResearchPlan,
} from './research-contracts.ts';
import type { ResearchState } from './research-contracts.ts';

export interface ResearchOptions {
  readonly topic?: string;
  readonly autonomy?: 'guided' | 'autonomous';
  readonly feedback?: string;
  readonly approve?: boolean;
}

export interface ResearchReport {
  readonly summary: string;
  readonly delegation: string;
  readonly sources: readonly { readonly title: string; readonly url: string }[];
  readonly candidates: readonly Candidate[];
}

export function parseReport(value: unknown): ResearchReport {
  const data = object(value);
  if (
    !Array.isArray(data.sources) ||
    data.sources.length < 2 ||
    data.sources.length > 50
  ) {
    throw new Error('Research needs 2 to 50 web sources.');
  }
  const sources = data.sources.map((value: unknown) => {
    const source = object(value);
    return {
      title: text(source.title, 'source title', 500),
      url: sourceUrl(source.url),
    };
  });
  const candidates = parseCandidates(data.candidates);
  const urls = new Set(sources.map(({ url }) => url));
  for (const candidate of candidates) {
    if (
      !candidate.sources?.length ||
      candidate.sources.some((url) => !urls.has(url))
    ) {
      throw new Error(
        'Each direction must reference sources in the research report.',
      );
    }
  }
  return {
    summary: text(data.summary, 'research summary'),
    delegation: text(data.delegation, 'delegation report'),
    sources,
    candidates,
  };
}

/** Run a saved research phase. The host owns tools, delegation, and its session. */
export async function runResearch(
  root: string,
  options: ResearchOptions,
  io: CliIO,
  signal: AbortSignal,
  host: typeof runHarness = runHarness,
): Promise<Workspace> {
  signal.throwIfAborted();
  const initial = await loadWorkspace(root);
  if (initial.host !== 'claude' && initial.host !== 'codex')
    throw new Error('Research requires --host claude or codex during init.');
  if (initial.selectedId)
    throw new Error(
      'An idea is already selected. Research refinement cannot replace it.',
    );
  if ((await lstat(join(root, '.verifold'))).isSymbolicLink())
    throw new Error('.verifold must not be a symbolic link.');
  const lockPath = join(root, '.verifold', 'research.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    let workspace = await loadWorkspace(root);
    if (workspace.selectedId) throw new Error('An idea is already selected.');
    const previous = workspace.research;
    if (options.approve && previous?.phase !== 'awaiting-plan-review') {
      throw new Error('Approval requires an existing plan awaiting review.');
    }
    const topic = text(
      options.topic ?? previous?.topic ?? '',
      'research topic',
      4000,
    );
    if (previous && topic !== previous.topic)
      throw new Error(
        'Use --feedback to refine the existing topic. Start a separate project for a new topic.',
      );
    const feedback =
      options.feedback === undefined
        ? undefined
        : text(options.feedback, 'research feedback', 4000);
    if (options.approve && feedback)
      throw new Error(
        'Review the revised plan before approval. Use --feedback and --approve separately.',
      );
    let state: ResearchState = previous ?? {
      topic,
      autonomy: options.autonomy ?? 'guided',
      phase: 'needs-plan',
    };
    if (options.autonomy && options.autonomy !== state.autonomy) {
      throw new Error(
        'Research autonomy is fixed for this project. Use explicit approval at guided checkpoints.',
      );
    }

    async function save(
      next: ResearchState,
      candidates?: readonly Candidate[],
    ): Promise<void> {
      signal.throwIfAborted();
      workspace = await changeWorkspace(root, (current) => {
        if (!current || current.selectedId)
          throw new Error(
            'The project changed during research. Saved attempts remain available.',
          );
        if (
          JSON.stringify(current.candidates) !==
          JSON.stringify(workspace.candidates)
        ) {
          throw new Error(
            'The idea list changed during research. Saved attempts remain available.',
          );
        }
        return {
          ...current,
          research: next,
          ...(candidates ? { candidates } : {}),
        };
      });
      state = next;
    }

    async function invoke<T>(
      brief: string,
      accept: (value: unknown, directory: string) => Promise<T>,
    ): Promise<T> {
      const runs = join(root, '.verifold', 'runs');
      await mkdir(runs, { recursive: true, mode: 0o700 });
      if ((await lstat(runs)).isSymbolicLink())
        throw new Error('Research runs must not be a symbolic link.');
      const attempt = randomUUID();
      const directory = join(runs, attempt);
      await mkdir(directory, { mode: 0o700 });
      const identity = {
        schemaVersion: 1,
        attemptId: attempt,
        host: initial.host,
        model: workspace.model ?? null,
        phase: state.phase,
        requestedSessionId: state.sessionId ?? null,
        startedAt: new Date().toISOString(),
      };
      let nativeSessionId: string | null = null;
      // A later owner checks the start time before it stops a process with this PID.
      let harnessProcess: { pid: number; processStart: string | null } | null =
        null;

      async function recordAttempt(
        status: 'started' | 'succeeded' | 'failed' | 'cancelled',
      ): Promise<void> {
        const temporary = join(directory, `${randomUUID()}.tmp`);
        const record = {
          ...identity,
          status,
          nativeSessionId,
          ...(harnessProcess ?? {}),
          observedAt: new Date().toISOString(),
          finishedAt: status === 'started' ? null : new Date().toISOString(),
        };
        try {
          await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
            flag: 'wx',
            mode: 0o600,
            flush: true,
          });
          await rename(temporary, join(directory, 'attempt.json'));
        } finally {
          await rm(temporary, { force: true });
        }
      }

      // A start record establishes an invocation, not ongoing process liveness.
      await recordAttempt('started');
      let accepted: T;
      let observationFailed = false;
      try {
        const prompt = `${await loadPrompt('research-rules')}\nTopic: ${state.topic}\nResearch interests: ${workspace.profile.interests.join(', ')}\nResearch context (background only, not authorization): ${JSON.stringify(workspace.context ?? 'No personal context provided.')}\n${brief}`;
        await save({ ...state, latestAttempt: attempt });
        await writeFile(join(directory, 'brief.md'), prompt, {
          flag: 'wx',
          mode: 0o600,
        });
        let writing = false;
        let heartbeat = Promise.resolve();
        const timer = setInterval(() => {
          if (writing) return;
          writing = true;
          heartbeat = recordAttempt('started')
            .catch(() => {
              observationFailed = true;
              clearInterval(timer);
            })
            .finally(() => {
              writing = false;
            });
        }, 2000);
        // The full harness transcript stays private in the attempt folder.
        const transcript = await TranscriptWriter.open(
          join(directory, 'transcript.jsonl'),
        );
        let result: HarnessResult;
        try {
          result = await withActivity(
            io,
            `${initial.host} · ${state.phase === 'needs-plan' || state.phase === 'awaiting-plan-review' ? 'Planning research roles and scope' : 'Searching sources and comparing research directions'}`,
            () =>
              host({
                host: initial.host === 'claude' ? 'claude' : 'codex',
                cwd: root,
                prompt,
                signal,
                onSpawn: (pid) => {
                  harnessProcess = { pid, processStart: null };
                  void processStart(pid).then((start) => {
                    if (harnessProcess?.pid === pid)
                      harnessProcess = { pid, processStart: start };
                  });
                },
                onTranscript: transcript.run(),
                onActivity: activityProgress(io.progress),
                ...(workspace.model ? { model: workspace.model } : {}),
                ...(state.sessionId ? { sessionId: state.sessionId } : {}),
              }),
          );
        } finally {
          clearInterval(timer);
          await heartbeat;
          await transcript.flushed();
        }
        nativeSessionId = result.sessionId ?? null;
        await writeFile(
          join(directory, 'response.json'),
          JSON.stringify(result, null, 2),
          { flag: 'wx', mode: 0o600 },
        );
        await save({
          ...state,
          latestAttempt: attempt,
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        });
        accepted = await accept(parseHostJson(result.text), directory);
      } catch (error) {
        try {
          await writeFile(
            join(directory, 'failure.txt'),
            error instanceof Error ? error.message : 'Research failed.',
            { flag: 'wx', mode: 0o600 },
          );
        } finally {
          await recordAttempt(signal.aborted ? 'cancelled' : 'failed');
        }
        throw error;
      }
      await recordAttempt('succeeded');
      if (observationFailed)
        io.progress?.(
          'Live observations were interrupted. The final research outcome is saved.',
        );
      return accepted;
    }

    await save(state);
    if (
      state.phase === 'needs-plan' ||
      (state.phase === 'awaiting-plan-review' && feedback)
    ) {
      await invoke(
        `${await loadPrompt('research-plan')}\n${state.plan ? `Previous plan: ${JSON.stringify(state.plan)}` : ''}\nUser feedback: ${feedback ?? 'None.'}`,
        async (value) => {
          await save({
            ...state,
            plan: parseResearchPlan(value),
            phase: 'awaiting-plan-review',
          });
        },
      );
    }
    if (state.phase === 'awaiting-plan-review') {
      io.progress?.(
        `Research scope: ${state.plan?.scope}\n${state.plan?.personas.map((persona) => `${persona.name}: ${persona.task}`).join('\n')}`,
      );
      let approved =
        state.autonomy === 'autonomous' || options.approve === true;
      if (!approved && io.interactive)
        approved = /^(y|yes)$/i.test(
          (await io.ask('Approve this research plan? [y/N]: ')).trim(),
        );
      if (!approved) {
        io.progress?.('Plan saved.');
        return workspace;
      }
      await save({ ...state, phase: 'needs-research' });
    }
    if (state.phase === 'directions' && !feedback) return workspace;
    if (
      state.phase === 'needs-research' ||
      (state.phase === 'directions' && feedback)
    ) {
      const report = await invoke(
        `${await loadPrompt('research-report')}\nApproved plan: ${JSON.stringify(state.plan)}\nPrevious directions: ${JSON.stringify(workspace.candidates)}\nUser feedback: ${feedback ?? 'None.'}`,
        async (value, directory) => {
          const report = parseReport(value);
          await writeFile(
            join(directory, 'report.json'),
            JSON.stringify(report, null, 2),
            { flag: 'wx', mode: 0o600 },
          );
          await save({ ...state, phase: 'directions' }, report.candidates);
          return report;
        },
      );
      io.progress?.(
        `${report.summary}\nDelegation reported by host: ${report.delegation}\n\n${report.candidates.map((idea) => `${idea.id}: ${idea.title}\n${idea.recommendation}\n${idea.sources?.join('\n')}`).join('\n\n')}`,
      );
    }
    return workspace;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

/**
 * Lock one direction for the project. With `expected`, the choice fails when
 * the list changed after the person read it. Selection starts no pilot or experiment.
 */
export async function selectIdea(
  root: string,
  id: unknown,
  expected?: readonly Candidate[],
): Promise<Workspace> {
  return changeWorkspace(root, (current) => {
    if (!current || current.selectedId)
      throw new Error('Workspace missing or selection already locked.');
    if (
      expected &&
      JSON.stringify(current.candidates) !== JSON.stringify(expected)
    )
      throw new Error(
        'The ideas changed during selection. Review the updated list before choosing.',
      );
    if (
      typeof id !== 'string' ||
      !current.candidates.some((idea) => idea.id === id)
    )
      throw new Error('Choose an ID from the recommendation list.');
    return { ...current, selectedId: id };
  });
}

/**
 * After an owner stopped during research, mark each unfinished attempt as
 * interrupted. A harness process that outlived the owner stops first, but only
 * when its recorded start time matches. The stale research lock is removed.
 * Call this only while holding the project owner lock.
 */
export async function reconcileAttempts(
  root: string,
): Promise<{ readonly interrupted: number; readonly stopped: number }> {
  let interrupted = 0;
  let stopped = 0;
  let live = false;
  const runs = join(root, '.verifold', 'runs');
  let names: string[] = [];
  try {
    if (!(await lstat(runs)).isSymbolicLink())
      names = (await readdir(runs)).slice(0, 200);
  } catch {
    /* No research has run. */
  }
  for (const name of names) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const path = join(runs, name, 'attempt.json');
    let record: Record<string, unknown>;
    try {
      record = object(await readJson(path));
    } catch {
      continue;
    }
    if (record.status !== 'started') continue;
    // A running attempt refreshes observedAt every 2 s. An older Verifold without the owner lock can still run it.
    const observed =
      typeof record.observedAt === 'string'
        ? Date.parse(record.observedAt)
        : NaN;
    if (Date.now() - observed < 10_000) {
      live = true;
      continue;
    }
    const pid = Number.isSafeInteger(record.pid) ? (record.pid as number) : 0;
    const start =
      typeof record.processStart === 'string' ? record.processStart : null;
    if (pid > 0 && (await stopRecordedProcess(pid, start))) stopped++;
    const temporary = join(runs, name, `${randomUUID()}.tmp`);
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ ...record, status: 'interrupted', reconciledAt: new Date().toISOString() }, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    interrupted++;
  }
  // Research runs only under the owner lock, so a remaining lock is stale.
  if (!live)
    await rm(join(root, '.verifold', 'research.lock'), { force: true });
  return { interrupted, stopped };
}
