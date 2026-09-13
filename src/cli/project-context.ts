import { loadPrompt } from './prompts.ts';
import { opendir } from 'node:fs/promises';
import type { CliIO } from './commands.ts';
import type { Agency } from './agency.ts';
import { contextFiles } from './context-files.ts';
import { withActivity } from './choices.ts';
import { runHarness } from './harness.ts';
import { parseContext } from './contracts.ts';
import { stripVTControlCharacters } from 'node:util';

/** Offer project-scoped context. Declining never reads file contents or calls a model. */
export async function investigateProject(
  root: string,
  brief: string,
  agency: Agency,
  io: CliIO,
  signal: AbortSignal,
  harness: typeof runHarness,
): Promise<string> {
  signal.throwIfAborted();
  let populated = false;
  try {
    const directory = await opendir(root);
    let inspected = 0;
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (inspected++ >= 200) break;
      if (
        !entry.name.startsWith('.') &&
        (entry.isFile() || entry.isDirectory())
      ) {
        populated = true;
        break;
      }
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return brief;
    throw error;
  }
  if (!populated) return brief;
  io.progress?.(
    `## Understand your project\n\nDirectory: ${root}\nHarness: ${agency.host} (${agency.model ?? 'host default model'})\n\n- Verifold supplies up to 10 top-level documentation and manifest files (256 KB each, 512 KB total).\n- Your harness can read project files, search the web, and use native agents to clarify this work.\n- Its existing configuration and permissions apply. Tools that need interactive approval can be denied in this background session.\n- The request forbids edits, installations, and experiments. You review the context and final brief before Verifold saves project memory.\n\nYour harness and model provider may process this context and retain session records.`,
  );
  const consent = await io.ask(
    'Let your harness investigate this project? [y/N]: ',
  );
  if (!/^(y|yes)$/i.test(consent.trim())) return brief;
  signal.throwIfAborted();
  try {
    const evidence = await contextFiles(root, 'project', signal).catch(() => {
      signal.throwIfAborted();
      return 'Verifold could not supply readable top-level documentation. Use native read tools to inspect the selected project.';
    });
    const result = await withActivity(
      io,
      `${agency.host} · Understanding this project`,
      async () =>
        harness({
          ...agency,
          cwd: root,
          signal,
          ...(io.progress ? { onActivity: io.progress } : {}),
          prompt: `${await loadPrompt('project-context')}\nInitial project direction: ${JSON.stringify(brief)}\nProject evidence:\n${evidence}`,
        }),
    );
    const draft = parseContext(result.text);
    io.progress?.(
      `Project brief for review:\n\n${stripVTControlCharacters(draft)}`,
    );
    const accepted = await io.ask('Use this project brief? [y/N]: ');
    signal.throwIfAborted();
    return /^(y|yes)$/i.test(accepted.trim()) ? draft : brief;
  } catch {
    signal.throwIfAborted();
    io.progress?.(
      'Project investigation did not finish. Your accepted research brief is unchanged; setup can continue.',
    );
    return brief;
  }
}
