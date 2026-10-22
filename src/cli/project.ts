import { lstat, mkdir, open, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Workspace } from '../core/contracts.ts';
import type { Profile } from '../core/profile.ts';
import { changeWorkspace, loadWorkspace, missing } from '../core/storage.ts';
import { writeComputeSettings, type ComputeSettings } from '../core/compute.ts';

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

/** The research profile of a project that no `--profile` import gives. */
export const defaultProfile: Profile = {
  name: 'Researcher',
  interests: ['Computational research'],
  scholar: '',
  github: '',
  session: '',
};

/** A path as the person wrote it: `~/` starts in the home folder, and a relative path in `cwd`. */
export function expandHome(path: string, cwd: string): string {
  return path.startsWith('~/')
    ? resolve(homedir(), path.slice(2))
    : resolve(cwd, path);
}

/** A folder as the person reads it, with the home folder as `~`. */
export function homeShown(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
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

/** How a lab project continues, in .verifold.md. */
const labGuide =
  "## Continue in the lab\n\nRun verifold in this project directory. It opens Verifold in your browser, where a lab works on the question: agents each own a direction, post what they find with proof on one board, and check each other's claims. You answer their calls on money, scope, access, or more time. The lab keeps working after you close the terminal. To stop it, run verifold stop.\n\n";

/** How a research project continues, in .verifold.md. */
function researchGuide(workspace: Workspace): string {
  return `## Continue researching\n\nRun verifold --desk in this project directory. It opens the old desk, where you approve the research plan, choose a direction, approve the task plan of the coordinator, and follow the team. The team keeps working after you close the terminal. To stop it, run verifold stop. Harness: ${workspace.host}; model: ${workspace.model ?? 'host default'}. The harness owns its tools, permissions, and sessions.\n\nWhen the old desk is closed, scripts can use verifold status, verifold research --approve, and verifold select --id with a direction ID.\n\n`;
}

/** Create a scaffold under the state-write lock; roll back only artifacts made by this call. */
export async function createProject(
  root: string,
  workspace: Workspace,
  topic: string | undefined,
  brief: string | undefined,
  signal: AbortSignal,
  /** A lab starts on the question after setup, so the guide in .verifold.md describes the lab. */
  lab = false,
  /** The project's first GPU limits, copied from the person's profile. */
  compute?: ComputeSettings,
): Promise<Workspace> {
  await checkProjectDirectory(root);
  const created: string[] = [];
  let markerCreated = false;
  // What this call made for the GPU limits, so a rollback removes only that.
  let limitsCreated = false;
  let computeCreated = false;
  const marker = join(root, '.verifold.md');
  const computeFolder = join(root, '.verifold', 'compute');
  const limits = join(computeFolder, 'settings.json');
  const exists = (path: string): Promise<boolean> =>
    lstat(path).then(
      () => true,
      (error: unknown) => {
        if (missing(error)) return false;
        throw error;
      },
    );
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
              )}\n- .verifold/: Private state, coordinator sessions, source reports, and research attempts.\n\n${lab ? labGuide : researchGuide(workspace)}Preserve sources, assumptions, evaluator definitions, negative results, and reproducible commands. Agent proposals are not evidence or execution approval.\n`,
          );
          await file.sync();
        } finally {
          await file.close();
        }
        // Compute settings that the folder holds already, such as from a key set here, stay as they are.
        if (compute && !(await exists(limits))) {
          computeCreated = !(await exists(computeFolder));
          limitsCreated = true;
          await writeComputeSettings(root, compute);
        }
        signal.throwIfAborted();
      },
      rollback: async () => {
        if (markerCreated) await rm(marker, { force: true });
        if (limitsCreated) await rm(limits, { force: true });
        if (computeCreated)
          await rmdir(computeFolder).catch(() => {
            /* Keep a folder that holds other files. */
          });
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
