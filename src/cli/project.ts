import { lstat, mkdir, open, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Workspace } from './contracts.ts';
import { changeWorkspace, loadWorkspace } from './storage.ts';

const folders = {
  literature: 'Source notes, papers, and citation provenance.',
  experiments: 'Reproducible code, configurations, and execution instructions.',
  results:
    'Raw outputs, metrics, and failed attempts; preserve original evidence.',
  figures: 'Plots and scripts that regenerate them from results.',
  docs: 'Research plans, decisions, methods, and write-ups.',
  agents:
    'Project-specific agent briefs and review notes; host settings stay with the host.',
} as const;

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Reject redirected project roots and conflicting artifacts before initialization. */
export async function checkProjectDirectory(root: string): Promise<void> {
  try {
    if (!(await lstat(root)).isDirectory())
      throw new Error(
        'Project root must be a real directory, not a file or symbolic link.',
      );
  } catch (error) {
    if (!missing(error)) throw error;
  }
  try {
    await loadWorkspace(root);
    throw new Error('Workspace already exists; refusing to overwrite it.');
  } catch (error) {
    if (!missing(error)) throw error;
  }
  for (const name of ['.verifold.md', ...Object.keys(folders)]) {
    try {
      const entry = await lstat(join(root, name));
      if (name === '.verifold.md' || !entry.isDirectory())
        throw new Error(
          `Project entry ${name} already exists or is not a real directory; refusing to overwrite it.`,
        );
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}

/** Create a scaffold under the state-write lock; roll back only artifacts made by this call. */
export async function createProject(
  root: string,
  workspace: Workspace,
  topic: string | undefined,
  brief: string | undefined,
  signal: AbortSignal,
): Promise<Workspace> {
  await checkProjectDirectory(root);
  const created: string[] = [];
  let markerCreated = false;
  const marker = join(root, '.verifold.md');
  return changeWorkspace(
    root,
    (current) => {
      signal.throwIfAborted();
      if (current)
        throw new Error('Workspace already exists; refusing to overwrite it.');
      return workspace;
    },
    {
      apply: async () => {
        await checkProjectDirectory(root);
        for (const name of Object.keys(folders)) {
          signal.throwIfAborted();
          const path = join(root, name);
          try {
            await mkdir(path, { mode: 0o700 });
            created.push(path);
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                'code' in error &&
                error.code === 'EEXIST' &&
                (await lstat(path)).isDirectory()
              )
            )
              throw error;
          }
        }
        const file = await open(marker, 'wx', 0o600);
        markerCreated = true;
        try {
          await file.writeFile(
            `# Verifold project\n\nPrivate research record. Review before publishing.\n\n## Starting question\n\n${topic ?? 'Not yet specified.'}\n\n## Research brief\n\n${brief ?? 'Run verifold research --topic "your question" to begin planning.'}\n\n## Workspace\n\n${Object.entries(
              folders,
            )
              .map(([name, purpose]) => `- ${name}/: ${purpose}`)
              .join(
                '\n',
              )}\n- .verifold/: Private state, coordinator sessions, source reports, and research attempts.\n\n## Continue researching\n\nRun commands from this project directory. Harness: ${workspace.host}; model: ${workspace.model ?? 'host default'}. The harness owns its tools, permissions, and sessions.\n\n1. Use verifold status to inspect the saved phase.\n2. Use verifold research to resume; review a guided plan with verifold research --feedback "your changes", then verifold research --approve.\n3. Use verifold select to explicitly choose a researched direction.\n4. Use verifold literature --memory or verifold handoff to print optional literature or pilot requests for your harness. These commands do not execute experiments.\n\nPreserve sources, assumptions, evaluator definitions, negative results, and reproducible commands. Agent proposals are not evidence or execution approval.\n`,
          );
          await file.sync();
        } finally {
          await file.close();
        }
        signal.throwIfAborted();
      },
      rollback: async () => {
        if (markerCreated) await rm(marker, { force: true });
        for (const path of created.reverse()) {
          // Never recursively delete: another process may have added user work.
          try {
            await rmdir(path);
          } catch {
            /* Keep nonempty directories. */
          }
        }
      },
    },
  );
}
