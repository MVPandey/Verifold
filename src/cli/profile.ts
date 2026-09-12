import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  loadAgency,
  agencyDirectory,
  loadMemory,
  loadProfileState,
  saveAgencyPreferences,
  setupProfile,
  type Agency,
} from './agency.ts';
import { choose } from './choices.ts';
import { runHarness, validateModel } from './harness.ts';
import type { CliIO } from './commands.ts';

export interface ProfileOptions {
  readonly agencyDir?: string;
  readonly host?: string;
  readonly model?: string;
  readonly setup?: boolean;
}

/** Configure global background without creating or changing a research project. */
export async function profileCommand(
  options: ProfileOptions,
  cwd: string,
  io: CliIO,
  signal: AbortSignal,
  harness: typeof runHarness = runHarness,
): Promise<void> {
  signal.throwIfAborted();
  if (options.setup && !io.interactive)
    throw new Error(
      'Profile setup requires an interactive terminal for source consent and review.',
    );
  if (
    !options.setup &&
    (options.host !== undefined || options.model !== undefined)
  )
    throw new Error('Use profile --setup to change the harness or model.');
  const directory = agencyDirectory(cwd, options.agencyDir);
  let agency = await loadAgency(directory);
  if (options.setup) {
    const host =
      options.host ??
      agency?.host ??
      (await choose(
        io,
        'Choose the harness for your global profile',
        [
          {
            value: 'claude',
            label: 'Claude Code',
            description: 'Use your existing Claude configuration.',
          },
          {
            value: 'codex',
            label: 'Codex',
            description: 'Use your existing Codex configuration.',
          },
        ],
        'claude',
      ));
    if (host !== 'claude' && host !== 'codex')
      throw new Error('Choose claude or codex for profile setup.');
    const modelInput =
      options.model ?? (agency?.host === host ? agency.model : undefined);
    const model = modelInput === 'default' ? undefined : modelInput;
    validateModel(model);
    agency = { host, ...(model ? { model } : {}) };
    io.progress?.(
      `Profile harness: ${host} (${model ?? 'host default model'}). Existing project settings stay unchanged.`,
    );
    await setupProfile(directory, cwd, agency, io, signal, harness);
  }
  const memory = await loadMemory(directory);
  const state = await loadProfileState(directory);
  const result = {
    path: join(directory, 'USER.md'),
    status: memory
      ? 'accepted'
      : state?.status === 'accepted'
        ? 'missing'
        : (state?.status ?? 'not-offered'),
    lastSetup: state?.status ?? null,
    agency: agency ?? null,
    markdown: memory ?? null,
  };
  io.out(
    io.interactive
      ? stripVTControlCharacters(
          `Global profile: ${result.status}\nProfile file: ${result.path}\n${memory ?? 'No approved profile saved.'}\nUse verifold profile --setup to create or revise your profile. You can also edit USER.md directly.`,
        )
      : JSON.stringify(result),
  );
}

/** Older projects can establish global setup without changing their saved harness or research. */
export async function ensureGlobalProfile(
  directory: string,
  cwd: string,
  suggested: Agency | undefined,
  io: CliIO,
  signal: AbortSignal,
  harness: typeof runHarness,
): Promise<void> {
  const agency = await loadAgency(directory);
  const memory = await loadMemory(directory);
  const state = await loadProfileState(directory);
  if (memory || state) {
    // An existing setup outcome must not trigger another history import.
    if (!agency && suggested)
      await saveAgencyPreferences(directory, suggested, signal);
    return;
  }
  const initial = agency ?? suggested;
  await profileCommand(
    {
      agencyDir: directory,
      setup: true,
      ...(initial
        ? {
            host: initial.host,
            ...(initial.model ? { model: initial.model } : {}),
          }
        : {}),
    },
    cwd,
    io,
    signal,
    harness,
  );
}
