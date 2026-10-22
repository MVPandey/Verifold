import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Agency } from './agency.ts';
import type { Workspace } from './contracts.ts';
import { validateModel, type HarnessName } from './harness.ts';

/**
 * Codex models, most capable first, as OpenAI describes them on 2026-10-20.
 * A lab agent gets the first one that the app-server offers.
 */
export const codexModels: readonly string[] = [
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
];

/** The most pages of Codex's `model/list` that Verifold reads, so a list that never ends still ends. */
export const codexModelPages = 10;

/** One JSON-RPC call on a connection to a Codex app-server. */
export type CodexCall = (
  method: string,
  params: Record<string, unknown>,
  onResult: (result: Record<string, unknown>) => void,
  onError?: () => void,
) => void;

/**
 * Read every page of Codex's `model/list`, at most `codexModelPages`, and
 * give the entries to `done`. A refused first page gives null. A refused
 * later page gives the entries of the pages before it.
 */
export function listCodexModels(
  call: CodexCall,
  done: (models: unknown[] | null) => void,
): void {
  const models: unknown[] = [];
  const page = (cursor: string | undefined, pages: number): void =>
    call(
      'model/list',
      { limit: 100, ...(cursor ? { cursor } : {}) },
      (result) => {
        if (Array.isArray(result.data))
          models.push(...(result.data as unknown[]));
        const next =
          typeof result.nextCursor === 'string' && result.nextCursor
            ? result.nextCursor
            : undefined;
        if (next && pages < codexModelPages) page(next, pages + 1);
        else done(models);
      },
      () => done(pages > 1 ? models : null),
    );
  page(undefined, 1);
}

/** Claude Code's Opus models: the alias or a full ID, with or without the 1M context. */
const opus = /^(?:opus|claude-opus-[0-9a-z][0-9a-z.-]*)(?:\[1m\])?$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The name to send as `model`: the model's own name, else its ID. Undefined: not a valid model ID. */
export function slug(model: Record<string, unknown>): string | undefined {
  const name =
    typeof model.model === 'string' && model.model ? model.model : model.id;
  try {
    validateModel(name);
    return name;
  } catch {
    return undefined;
  }
}

/** The entries of Codex's `model/list` that it does not hide. */
export function offered(models: readonly unknown[]): Record<string, unknown>[] {
  return models.filter(
    (model): model is Record<string, unknown> =>
      record(model) && model.hidden !== true,
  );
}

/**
 * Verifold's pick in the entries of Codex's `model/list`: the first of
 * `codexModels` that it offers. Hidden models do not count. Undefined when it
 * offers none of them: the thread then starts with the person's own Codex
 * model, which can differ from the model that the list marks as the default.
 */
export function pickCodexModel(models: readonly unknown[]): string | undefined {
  const names = offered(models).map(slug);
  return codexModels.find((name) => names.includes(name));
}

/** A reasoning effort as Codex names one, such as `high`. */
const effortName = /^[a-z]{1,20}$/;

/**
 * The reasoning effort for a thread on `model` when `effort`, the person's
 * own, is one that the model does not support: the model's default effort.
 * Undefined when the effort fits, or when the list does not say what fits.
 */
export function codexEffort(
  models: readonly unknown[],
  model: string,
  effort: unknown,
): string | undefined {
  const entry = offered(models).find((candidate) => slug(candidate) === model);
  if (!entry || typeof effort !== 'string' || !effort) return undefined;
  const supported = Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts.flatMap((option: unknown) =>
        record(option) &&
        typeof option.reasoningEffort === 'string' &&
        effortName.test(option.reasoningEffort)
          ? [option.reasoningEffort]
          : [],
      )
    : [];
  const fallback = entry.defaultReasoningEffort;
  return supported.length &&
    !supported.includes(effort) &&
    typeof fallback === 'string' &&
    supported.includes(fallback)
    ? fallback
    : undefined;
}

/** `model` when it is a valid Opus model ID, else null. */
function opusModel(model: unknown): string | null {
  if (typeof model !== 'string' || !opus.test(model)) return null;
  try {
    validateModel(model);
    return model;
  } catch {
    return null;
  }
}

/** Claude Code's user settings. Null: the file is missing, too large, or not a JSON object. */
async function userSettings(
  folder: string,
): Promise<Record<string, unknown> | null> {
  const path = join(folder, 'settings.json');
  try {
    // A settings file is small. Anything else, such as a pipe, is not read.
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024) return null;
    const settings: unknown = JSON.parse(await readFile(path, 'utf8'));
    return record(settings) ? settings : null;
  } catch {
    return null;
  }
}

/**
 * The person's own Claude Code model when it is an Opus model, exactly as
 * written (so `opus[1m]` keeps its 1M context), else null. Verifold follows
 * Claude Code's order (https://code.claude.com/docs/en/env-vars#precedence)
 * within the user settings: an `ANTHROPIC_MODEL` in their `env` block
 * replaces the one in the environment, and an empty one cancels it. Then
 * `ANTHROPIC_MODEL` wins over the `model` key. Verifold reads no project or
 * managed settings.
 */
export async function claudeOpus(
  folder = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
): Promise<string | null> {
  const settings = await userSettings(folder);
  const block = settings && record(settings.env) ? settings.env : {};
  const named =
    typeof block.ANTHROPIC_MODEL === 'string'
      ? block.ANTHROPIC_MODEL
      : process.env.ANTHROPIC_MODEL;
  return opusModel(named || settings?.model);
}

/** The Claude Code model for lab agents: the person's own Opus model, else `opus`. */
export async function claudeModel(folder?: string): Promise<string> {
  return (await claudeOpus(folder)) ?? 'opus';
}

/** The model that the person's profile picked for a harness, if any. */
export function profileModel(
  host: HarnessName,
  agency: Pick<Agency, 'host' | 'model' | 'helper' | 'helperModel'> | null,
): string | undefined {
  return agency?.host === host
    ? agency.model
    : agency?.helper === host
      ? agency.helperModel
      : undefined;
}

/**
 * The model of a lab agent, planner, or checker. A project model for the
 * harness wins, then the model that the person's profile picked for the
 * harness. Otherwise Claude Code gets `claudeModel`, and Codex gets null:
 * the agent's own app-server then gives it the first of Verifold's preferred
 * models that it lists, else the person's own Codex model.
 */
export async function labModel(
  host: HarnessName,
  workspace: Pick<
    Workspace,
    'host' | 'model' | 'helper' | 'helperModel'
  > | null,
  agency: Pick<
    Agency,
    'host' | 'model' | 'helper' | 'helperModel'
  > | null = null,
): Promise<string | null> {
  if (workspace?.host === host && workspace.model) return workspace.model;
  if (workspace?.helper === host && workspace.helperModel)
    return workspace.helperModel;
  const picked = profileModel(host, agency);
  if (picked) return picked;
  return host === 'claude' ? claudeModel() : null;
}
