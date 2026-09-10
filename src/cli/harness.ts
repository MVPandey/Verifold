import { spawn } from 'node:child_process';

export type HarnessName = 'claude' | 'codex';

export interface HarnessRequest {
  readonly host: HarnessName;
  readonly cwd: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly sessionId?: string;
}

export interface HarnessResult {
  readonly text: string;
  readonly sessionId?: string;
}

export interface HarnessOptions {
  /** Override the executable for an isolated host installation or a test fixture. */
  readonly executable?: string;
}

const maxBytes = 2 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
    ? value
    : undefined;
}

function parseResult(host: HarnessName, output: string): HarnessResult {
  if (host === 'claude') {
    const result: unknown = JSON.parse(output);
    if (!record(result) || result.is_error === true) {
      throw new Error(
        'Claude reported a failed request. Check the host session.',
      );
    }
    if (typeof result.result !== 'string' || !result.result.trim()) {
      throw new Error('Claude returned no result text.');
    }
    const id = sessionId(result.session_id);
    return { text: result.result, ...(id ? { sessionId: id } : {}) };
  }

  let result: string | undefined;
  let id: string | undefined;
  for (const line of output.split('\n').filter((line) => line.trim())) {
    const event: unknown = JSON.parse(line);
    if (!record(event)) throw new Error('Codex returned an invalid event.');
    if (event.type === 'thread.started') id = sessionId(event.thread_id);
    if (event.type === 'turn.failed' || event.type === 'error') {
      throw new Error(
        'Codex reported a failed request. Check the host session.',
      );
    }
    if (
      event.type === 'item.completed' &&
      record(event.item) &&
      event.item.type === 'agent_message' &&
      typeof event.item.text === 'string'
    ) {
      result = event.item.text;
    }
  }
  if (!result?.trim()) throw new Error('Codex returned no result text.');
  return { text: result, ...(id ? { sessionId: id } : {}) };
}

/**
 * Run one host request with the user's host configuration and permissions.
 * Prompts use stdin. Output and input are limited to 2 MiB each. The default
 * deadline is ten minutes. Cancellation stops the process group on POSIX.
 * Errors exclude raw host output, which can contain private session data.
 */
export async function runHarness(
  request: HarnessRequest,
  options: HarnessOptions = {},
): Promise<HarnessResult> {
  request.signal.throwIfAborted();
  if (request.sessionId !== undefined && !sessionId(request.sessionId)) {
    throw new Error('Harness session ID has an invalid format.');
  }
  const timeoutMs = request.timeoutMs ?? 600_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new Error(
      'Harness timeout must be a positive integer in milliseconds.',
    );
  }
  if (Buffer.byteLength(request.prompt) > maxBytes) {
    throw new Error('Harness prompt exceeds the 2 MiB limit.');
  }
  const args =
    request.host === 'claude'
      ? [
          '-p',
          '--output-format',
          'json',
          ...(request.sessionId ? ['--resume', request.sessionId] : []),
        ]
      : [
          '--search',
          'exec',
          '--skip-git-repo-check',
          '--color',
          'never',
          '--json',
          ...(request.sessionId ? ['resume', request.sessionId, '-'] : ['-']),
        ];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(options.executable ?? request.host, args, {
      cwd: request.cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    function kill(signal: NodeJS.Signals): void {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (!record(error) || error.code !== 'ESRCH') {
          failure ??= new Error('Could not stop the harness process.', {
            cause: error,
          });
        }
      }
    }

    function stop(error: Error): void {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1_000);
    }

    function abort(): void {
      stop(
        new Error('Harness request was cancelled.', {
          cause: request.signal.reason,
        }),
      );
    }

    const deadline = setTimeout(
      () => stop(new Error('Harness request exceeded its time limit.')),
      timeoutMs,
    );
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();

    function consume(chunk: Buffer, retain: boolean): void {
      size += chunk.length;
      if (size > maxBytes)
        stop(new Error('Harness output exceeds the 2 MiB limit.'));
      else if (retain) chunks.push(chunk);
    }

    child.stdout.on('data', (chunk: Buffer) => consume(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
    child.stdin.on('error', (error: Error) =>
      stop(new Error('Could not send the harness prompt.', { cause: error })),
    );
    child.on('error', (error) => {
      failure ??= new Error(
        `Could not start ${request.host}. Check that it is installed and available.`,
        { cause: error },
      );
    });
    child.on('close', (code) => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      request.signal.removeEventListener('abort', abort);
      if (failure) {
        kill('SIGKILL');
        reject(failure);
      } else if (code !== 0) {
        reject(
          new Error(
            `${request.host} exited with status ${String(code)}. Check host authentication and permissions.`,
          ),
        );
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(request.prompt);
  });
  try {
    return parseResult(request.host, output);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${request.host} returned invalid JSON.`, {
        cause: error,
      });
    }
    throw error;
  }
}
