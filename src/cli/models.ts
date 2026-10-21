import { execFile } from 'node:child_process';
import { childEnvironment, validateModel } from './harness.ts';

/**
 * Codex models, most capable first, as OpenAI describes them on 2026-10-20.
 * A lab agent gets the first one that the app-server offers.
 */
export const codexModels: readonly string[] = [
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
];

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
 * The Claude Code model for lab agents. `best` follows Claude Code's most
 * capable model, which a Max plan includes. On other plans it can bill usage
 * credits, and headless Claude Code does not ask first. So every other plan,
 * an API key, and any failure of `claude auth status` give `opus`.
 */
export function claudeModel(executable = 'claude'): Promise<'best' | 'opus'> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ['auth', 'status', '--json'],
      {
        env: childEnvironment(),
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) return resolve('opus');
        try {
          const status: unknown = JSON.parse(stdout);
          resolve(
            record(status) &&
              status.authMethod === 'claude.ai' &&
              status.subscriptionType === 'max'
              ? 'best'
              : 'opus',
          );
        } catch {
          resolve('opus');
        }
      },
    );
  });
}
