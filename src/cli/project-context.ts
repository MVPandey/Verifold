import { loadPrompt } from './prompts.ts';
import { opendir } from 'node:fs/promises';
import type { CliIO } from './commands.ts';
import type { Agency } from './agency.ts';
import { contextFiles, projectContextFile } from './context-files.ts';
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
      if (entry.isFile() && projectContextFile(entry.name)) {
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
  const consent = await io.ask(
    `This directory already contains work: ${root}\nWould you like your agent to investigate its context? Verifold will read up to 10 top-level README, AGENTS.md, CLAUDE.md, and project manifest files (256 KB each, 512 KB total), then send them to ${agency.host} (${agency.model ?? 'host default model'}). Verifold’s evidence excludes source code, hidden files, and linked files. Your harness runs in this directory with its own project configuration, tools, and permissions. You review this context before the interview. The accepted final research brief is saved as project memory in .verifold.md. If you accept this context, the following conversation may use your harness to read files within this project, search the web, and delegate to native agents under its existing permissions. The conversation must not edit files, install software, or run experiments. [y/N]: `,
  );
  if (!/^(y|yes)$/i.test(consent.trim())) return brief;
  signal.throwIfAborted();
  try {
    const evidence = await contextFiles(root, 'project', signal);
    const result = await withActivity(
      io,
      `${agency.host} · Understanding this project`,
      async () =>
        harness({
          ...agency,
          cwd: root,
          signal,
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
