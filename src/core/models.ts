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
 * give the entries to `done`. A page that Codex refuses gives null.
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
      () => done(null),
    );
  page(undefined, 1);
}

/** Claude Code's Opus models: the alias or a full ID, with or without the 1M context. */
const opus = /^(?:opus|claude-opus-[0-9a-z][0-9a-z.-]*)(?:\[1m\])?$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The name to send as `model`: the model's own name, else its ID. */
function slug(model: Record<string, unknown>): string | undefined {
  const name =
    typeof model.model === 'string' && model.model ? model.model : model.id;
  try {
    validateModel(name);
    return name;
  } catch {
    return undefined;
  }
}

/**
 * The most capable model in the entries of Codex's `model/list`: the first of
 * `codexModels` that it offers, else the model that it marks as the default.
 * Hidden models do not count. Undefined when no entry fits: the thread then
 * starts with the person's own Codex model.
 */
export function pickCodexModel(models: readonly unknown[]): string | undefined {
  const offered = models.filter(
    (model): model is Record<string, unknown> =>
      record(model) && model.hidden !== true,
  );
  const names = offered.map(slug);
  const best = codexModels.find((name) => names.includes(name));
  if (best) return best;
  const fallback = offered.find((model) => model.isDefault === true);
  return fallback ? slug(fallback) : undefined;
}

/**
 * The person's own Claude Code model when it is an Opus model, exactly as
 * written (so `opus[1m]` keeps its 1M context), else null. Verifold reads
 * only the `model` key of Claude Code's user settings.
 */
export async function claudeOpus(
  folder = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
): Promise<string | null> {
  const path = join(folder, 'settings.json');
  try {
    // A settings file is small. Anything else, such as a pipe, is not read.
    const info = await stat(path);
    if (info.isFile() && info.size <= 1024 * 1024) {
      const settings: unknown = JSON.parse(await readFile(path, 'utf8'));
      const model = record(settings) ? settings.model : undefined;
      if (typeof model === 'string' && opus.test(model)) return model;
    }
  } catch {
    /* A missing or broken file leaves the default. */
  }
  return null;
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
 * project's main harness wins, then the model that the person's profile
 * picked for the harness. Otherwise Claude Code gets `claudeModel`, and
 * Codex gets null: it picks its most capable model on its own app-server.
 */
export async function labModel(
  host: HarnessName,
  workspace: Pick<Workspace, 'host' | 'model'> | null,
  agency: Pick<
    Agency,
    'host' | 'model' | 'helper' | 'helperModel'
  > | null = null,
): Promise<string | null> {
  if (workspace?.host === host && workspace.model) return workspace.model;
  const picked = profileModel(host, agency);
  if (picked) return picked;
  return host === 'claude' ? claudeModel() : null;
}
