import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { HarnessName } from './harness.ts';
import {
  claudeUpdates,
  codexAppUpdates,
  type TranscriptUpdate,
} from './transcript.ts';

/** `strict`: a task session. The harness itself limits writes to the task folder and asks nothing. */
export type SessionMode = 'ask' | 'auto' | 'strict';

/**
 * Claude Code settings for a strict task session: shell commands run in the
 * sandbox, file tools may edit only the working folder, and dontAsk mode
 * denies the rest. Probed on Claude Code 2.1.288.
 */
const strictClaudeSettings = JSON.stringify({
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
  permissions: {
    allow: ['Edit(./**)', 'Write(./**)', 'WebSearch', 'WebFetch'],
  },
});

/** Observed protocol events. Agent text is a model claim; the other events come from the protocol. */
export type HostEvent =
  | {
      readonly type: 'session';
      readonly id: string;
      readonly model?: string;
      readonly mode?: string;
    }
  | { readonly type: 'mode'; readonly mode: string }
  | { readonly type: 'message'; readonly text: string }
  | {
      readonly type: 'tool';
      readonly id: string;
      readonly tool: string;
      readonly action: string;
    }
  | {
      readonly type: 'tool-end';
      readonly id: string;
      readonly outcome: 'ok' | 'failed' | 'declined';
      readonly exitCode?: number;
    }
  | {
      readonly type: 'request';
      readonly id: string;
      readonly toolId?: string;
      readonly tool: string;
      readonly action: string;
      /** The content that a write or edit would change. */
      readonly detail?: string;
      readonly reason?: string;
    }
  /** The harness withdrew an open request, for example when its turn stopped. */
  | { readonly type: 'request-end'; readonly id: string }
  | {
      readonly type: 'denied';
      readonly toolId: string;
      readonly reason: string;
    }
  | {
      readonly type: 'review';
      readonly toolId: string;
      readonly approved: boolean;
      readonly action?: string;
      readonly risk?: string;
      readonly rationale?: string;
    }
  | {
      readonly type: 'turn-end';
      readonly status: 'completed' | 'interrupted' | 'failed';
      readonly costUsd?: number;
    }
  | { readonly type: 'notice'; readonly text: string }
  /** One transcript update: full messages, tool inputs, and tool results. Private session data. */
  | { readonly type: 'transcript'; readonly update: TranscriptUpdate }
  | { readonly type: 'exit'; readonly code: number | null };

export interface HostOptions {
  readonly host: HarnessName;
  readonly cwd: string;
  readonly mode: SessionMode;
  readonly model?: string;
  /** The first request. A resumed session has none and waits for a follow-up. */
  readonly prompt?: string;
  /** Claude Code only: the session ID for a new conversation, chosen before launch. */
  readonly sessionId?: string;
  /** The native session or thread to continue in this new process. */
  readonly resume?: string;
  /** Override the executable for an isolated host installation or a test fixture. */
  readonly executable?: string;
  readonly clientVersion: string;
  readonly onEvent: (event: HostEvent) => void;
}

/** One live harness process. Every method is safe to call after the process exits. */
export interface HostSession {
  /** The harness process. It leads its own process group on POSIX. */
  readonly pid: number | undefined;
  /** Start a new turn. The caller sends a follow-up only after the previous turn ends. */
  send(text: string): void;
  /** Deny the listed open requests and stop the current turn. */
  interrupt(pending: readonly string[]): void;
  answer(id: string, allow: boolean): void;
  close(): void;
}

const maxLine = 8 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Split newline-delimited output. A line above 8 MiB is dropped, not buffered. */
function readLines(
  stream: NodeJS.ReadableStream,
  onLine: (value: unknown) => void,
  onNotice: (text: string) => void,
): void {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let dropping = false;
  stream.on('data', (chunk: Buffer) => {
    const lines = (pending + decoder.write(chunk)).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (dropping) {
        dropping = false;
        continue;
      }
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        onNotice('Verifold could not read one line of harness output.');
        continue;
      }
      onLine(value);
    }
    if (pending.length > maxLine) {
      pending = '';
      dropping = true;
      onNotice('Verifold dropped one harness message above 8 MiB.');
    }
  });
}

function launch(
  command: string,
  args: readonly string[],
  options: HostOptions,
): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, {
    cwd: options.cwd,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Harness diagnostics can contain private session data, so they are not retained.
  child.stderr.resume();
  child.stdin.on('error', () => {
    /* The exit event reports a harness that closed its input. */
  });
  child.on('error', () =>
    options.onEvent({
      type: 'notice',
      text: `Could not start ${options.host === 'claude' ? 'Claude Code' : 'Codex'}. Check that it is installed and signed in.`,
    }),
  );
  child.on('close', (code) => options.onEvent({ type: 'exit', code }));
  return child;
}

/** Stop the whole process group, then force it after a grace period. */
function stop(child: ChildProcessWithoutNullStreams): void {
  // The group can outlive its leader, so the forced step does not check the leader's exit.
  const kill = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      /* The process group already exited. */
    }
  };
  kill('SIGTERM');
  setTimeout(() => kill('SIGKILL'), 2000).unref();
}

function write(child: ChildProcessWithoutNullStreams, value: unknown): void {
  if (child.stdin.writable) child.stdin.write(`${JSON.stringify(value)}\n`);
}

const claudeFields: Record<string, string> = {
  Bash: 'command',
  WebFetch: 'url',
  WebSearch: 'query',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  Glob: 'pattern',
  Grep: 'pattern',
};

/**
 * The input field that tells a person what a Claude Code tool call acts on.
 * A description written by the model is never used, because it can differ from the input.
 */
function claudeAction(tool: string, input: unknown): string {
  if (!record(input)) return '';
  const field = Object.hasOwn(claudeFields, tool)
    ? claudeFields[tool]
    : undefined;
  const value = field ? input[field] : undefined;
  return typeof value === 'string' ? value : JSON.stringify(input);
}

/** The content that a Claude Code write or edit would change. */
function claudeDetail(tool: string, input: unknown): string | undefined {
  if (!record(input)) return undefined;
  if (tool === 'Write') return str(input.content);
  if (tool === 'Edit')
    return `- ${str(input.old_string) ?? ''}\n+ ${str(input.new_string) ?? ''}`;
  if (tool === 'MultiEdit' || tool === 'NotebookEdit')
    return JSON.stringify(input, null, 2);
  return undefined;
}

/**
 * Claude Code through its stream-json control protocol. The CLI sends each
 * permission prompt to this process as a `can_use_tool` request.
 */
function claude(options: HostOptions): HostSession {
  const child = launch(
    options.executable ?? 'claude',
    [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      options.mode === 'auto'
        ? 'auto'
        : options.mode === 'strict'
          ? 'dontAsk'
          : 'default',
      ...(options.mode === 'strict'
        ? ['--settings', strictClaudeSettings]
        : []),
      ...(options.model ? ['--model', options.model] : []),
      ...(options.resume
        ? ['--resume', options.resume]
        : options.sessionId
          ? ['--session-id', options.sessionId]
          : []),
    ],
    options,
  );
  const emit = options.onEvent;
  const inputs = new Map<string, unknown>();
  let interrupting = false;
  const user = (text: string): void =>
    write(child, {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
  const answer = (id: string, allow: boolean, interrupt = false): void => {
    if (!inputs.has(id)) return;
    const input = inputs.get(id);
    inputs.delete(id);
    write(child, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: id,
        response: allow
          ? { behavior: 'allow', updatedInput: input }
          : {
              behavior: 'deny',
              message: 'The person denied this request in Verifold.',
              ...(interrupt ? { interrupt: true } : {}),
            },
      },
    });
  };

  readLines(
    child.stdout,
    (event) => {
      if (!record(event)) return;
      for (const update of claudeUpdates(event))
        emit({ type: 'transcript', update });
      if (event.type === 'system') {
        if (event.subtype === 'init') {
          const id = str(event.session_id);
          const model = str(event.model);
          const mode = str(event.permissionMode);
          if (id)
            emit({
              type: 'session',
              id,
              ...(model ? { model } : {}),
              ...(mode ? { mode } : {}),
            });
        } else if (event.subtype === 'status' && str(event.permissionMode))
          emit({ type: 'mode', mode: String(event.permissionMode) });
        else if (event.subtype === 'permission_denied') {
          const toolId = str(event.tool_use_id);
          if (toolId)
            emit({
              type: 'denied',
              toolId,
              reason: str(event.decision_reason_type) ?? 'unknown',
            });
        }
      } else if (
        (event.type === 'assistant' || event.type === 'user') &&
        record(event.message) &&
        Array.isArray(event.message.content)
      ) {
        for (const block of event.message.content as unknown[]) {
          if (!record(block)) continue;
          if (event.type === 'assistant' && block.type === 'text') {
            const text = str(block.text);
            if (text) emit({ type: 'message', text });
          } else if (event.type === 'assistant' && block.type === 'tool_use') {
            const id = str(block.id);
            const tool = str(block.name) ?? 'Tool';
            if (id)
              emit({
                type: 'tool',
                id,
                tool,
                action: claudeAction(tool, block.input),
              });
          } else if (event.type === 'user' && block.type === 'tool_result') {
            const id = str(block.tool_use_id);
            if (id)
              emit({
                type: 'tool-end',
                id,
                outcome: block.is_error === true ? 'failed' : 'ok',
              });
          }
        }
      } else if (event.type === 'control_request' && record(event.request)) {
        const id = str(event.request_id);
        if (!id) return;
        if (event.request.subtype === 'can_use_tool') {
          const tool = str(event.request.tool_name) ?? 'Tool';
          const toolId = str(event.request.tool_use_id);
          const reason = str(event.request.description);
          const detail = claudeDetail(tool, event.request.input);
          inputs.set(id, event.request.input);
          emit({
            type: 'request',
            id,
            tool,
            action: claudeAction(tool, event.request.input),
            ...(toolId ? { toolId } : {}),
            ...(detail ? { detail } : {}),
            ...(reason ? { reason } : {}),
          });
        } else
          write(child, {
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: id,
              error: 'Verifold does not support this request.',
            },
          });
      } else if (event.type === 'control_cancel_request') {
        const id = str(event.request_id);
        if (id && inputs.delete(id)) emit({ type: 'request-end', id });
      } else if (event.type === 'result') {
        const cost = event.total_cost_usd;
        emit({
          type: 'turn-end',
          status: interrupting
            ? 'interrupted'
            : event.is_error === true || event.subtype !== 'success'
              ? 'failed'
              : 'completed',
          ...(typeof cost === 'number' && Number.isFinite(cost)
            ? { costUsd: cost }
            : {}),
        });
        interrupting = false;
      }
    },
    (text) => emit({ type: 'notice', text }),
  );
  write(child, {
    type: 'control_request',
    request_id: `verifold-${randomUUID()}`,
    request: { subtype: 'initialize' },
  });
  if (options.prompt) user(options.prompt);
  else if (options.resume) {
    const id = options.resume;
    // Claude Code reports its session only after the next message, so the resumed ID is the one Verifold asked for.
    // The event waits until the caller holds this session.
    queueMicrotask(() => emit({ type: 'session', id }));
  }
  return {
    pid: child.pid,
    send: user,
    interrupt(pending) {
      interrupting = true;
      if (pending.length) for (const id of pending) answer(id, false, true);
      else
        write(child, {
          type: 'control_request',
          request_id: `verifold-${randomUUID()}`,
          request: { subtype: 'interrupt' },
        });
    },
    answer: (id, allow) => answer(id, allow),
    close() {
      child.stdin.end();
      stop(child);
    },
  };
}

/**
 * The exact command that Codex runs. The shell wrapper that Codex adds is
 * removed only when its quoting is unambiguous. The parsed `commandActions`
 * are not used, because they can list only part of a compound command.
 */
export function codexCommand(item: Record<string, unknown>): string {
  const command = str(item.command) ?? '';
  const inner = /^\S*\/(?:ba|z)?sh -l?c '((?:[^']|'\\'')*)'$/.exec(
    command,
  )?.[1];
  return inner === undefined ? command : inner.replaceAll("'\\''", "'");
}

/**
 * Codex through `codex app-server` (JSON-RPC over stdio). Ask me routes
 * approvals to this client. Auto routes them to the Codex reviewer agent.
 */
function codex(options: HostOptions): HostSession {
  const child = launch(options.executable ?? 'codex', ['app-server'], options);
  const emit = options.onEvent;
  const results = new Map<
    number,
    {
      readonly method: string;
      readonly onResult?: (result: Record<string, unknown>) => void;
    }
  >();
  const requests = new Map<string, number | string>();
  const changes = new Map<string, { paths: string; diff: string }>();
  let nextId = 1;
  let thread: string | undefined;
  let turn: string | undefined;
  let cancelled = false;
  const call = (
    method: string,
    params: Record<string, unknown>,
    onResult?: (result: Record<string, unknown>) => void,
  ): void => {
    const id = nextId++;
    results.set(id, { method, ...(onResult ? { onResult } : {}) });
    write(child, { method, id, params });
  };
  const interruptTurn = (): void => {
    if (thread && turn)
      call('turn/interrupt', { threadId: thread, turnId: turn });
  };
  const startTurn = (text: string): void => {
    if (!thread) return;
    call(
      'turn/start',
      { threadId: thread, input: [{ type: 'text', text }] },
      (result) => {
        if (record(result.turn)) turn = str(result.turn.id);
        // A cancel can arrive before Codex reports the turn ID.
        if (cancelled) interruptTurn();
      },
    );
  };
  const answer = (id: string, allow: boolean): void => {
    const rpcId = requests.get(id);
    if (rpcId === undefined) return;
    requests.delete(id);
    write(child, {
      id: rpcId,
      result: { decision: allow ? 'accept' : 'decline' },
    });
  };
  /** Subagent threads and the tool call that started each one. */
  const agents = new Map<string, string>();
  /** Item IDs of a subagent thread get its thread ID, so they cannot match IDs of the main thread. */
  const transcribe = (
    method: string,
    value: unknown,
    from: string | null,
  ): void => {
    const local = (id: string): string => (from ? `${from}/${id}` : id);
    if (
      record(value) &&
      value.type === 'collabAgentToolCall' &&
      typeof value.id === 'string' &&
      Array.isArray(value.receiverThreadIds)
    )
      for (const child of value.receiverThreadIds as unknown[])
        if (typeof child === 'string' && agents.size < 500)
          agents.set(child, local(value.id));
    const parent = from ? (agents.get(from) ?? null) : null;
    for (const update of codexAppUpdates(method, value, parent))
      emit({
        type: 'transcript',
        update:
          update.id === undefined
            ? update
            : { ...update, id: local(update.id) },
      });
  };
  const item = (method: string, value: unknown): void => {
    if (!record(value)) return;
    const id = str(value.id);
    if (!id) return;
    const started = method === 'item/started';
    const status = str(value.status);
    const end = (): void => {
      if (started) return;
      const exit = value.exitCode;
      emit({
        type: 'tool-end',
        id,
        outcome:
          status === 'declined'
            ? 'declined'
            : status === 'failed' ||
                (typeof exit === 'number' && exit !== 0) ||
                value.error
              ? 'failed'
              : 'ok',
        ...(typeof exit === 'number' ? { exitCode: exit } : {}),
      });
    };
    if (value.type === 'commandExecution') {
      if (started)
        emit({
          type: 'tool',
          id,
          tool: 'Command',
          action: codexCommand(value),
        });
      end();
    } else if (value.type === 'fileChange') {
      const list = (
        Array.isArray(value.changes) ? (value.changes as unknown[]) : []
      ).filter(record);
      const paths = list
        .map((change) => str(change.path))
        .filter(Boolean)
        .join(', ');
      if (started) {
        changes.set(id, {
          paths,
          diff: list.map((change) => str(change.diff) ?? '').join('\n'),
        });
        emit({ type: 'tool', id, tool: 'File change', action: paths });
      } else changes.delete(id);
      end();
    } else if (value.type === 'mcpToolCall') {
      if (started)
        emit({
          type: 'tool',
          id,
          tool: 'MCP tool',
          action: `${str(value.server) ?? 'server'}.${str(value.tool) ?? 'tool'}`,
        });
      end();
    } else if (value.type === 'webSearch' && !started) {
      emit({
        type: 'tool',
        id,
        tool: 'Web search',
        action: str(value.query) ?? '',
      });
      emit({ type: 'tool-end', id, outcome: 'ok' });
    } else if (value.type === 'agentMessage' && !started) {
      const text = str(value.text);
      if (text) emit({ type: 'message', text });
    }
  };

  readLines(
    child.stdout,
    (message) => {
      if (!record(message)) return;
      const method = str(message.method);
      const params = record(message.params) ? message.params : {};
      const rpcId =
        typeof message.id === 'number' || typeof message.id === 'string'
          ? message.id
          : undefined;
      if (method && rpcId !== undefined) {
        const key = `c${rpcId}`;
        if (
          method === 'item/commandExecution/requestApproval' ||
          method === 'item/fileChange/requestApproval'
        ) {
          const toolId = str(params.itemId);
          const reason = str(params.reason);
          const change = toolId ? changes.get(toolId) : undefined;
          requests.set(key, rpcId);
          emit({
            type: 'request',
            id: key,
            tool: method.includes('command') ? 'Command' : 'File change',
            action: method.includes('command')
              ? codexCommand(params)
              : (change?.paths ?? str(params.grantRoot) ?? 'File changes'),
            ...(toolId ? { toolId } : {}),
            ...(change?.diff ? { detail: change.diff } : {}),
            ...(reason ? { reason } : {}),
          });
        } else {
          write(child, {
            id: rpcId,
            error: {
              code: -32601,
              message: 'Verifold does not support this request.',
            },
          });
          emit({
            type: 'notice',
            text: `Codex sent a request that Verifold does not support (${method}). Verifold declined it.`,
          });
        }
        return;
      }
      if (typeof message.id === 'number') {
        const pending = results.get(message.id);
        results.delete(message.id);
        if (record(message.error)) {
          emit({
            type: 'notice',
            text: `Codex rejected ${pending?.method ?? 'a request'}: ${str(message.error.message) ?? 'unknown error'}.`,
          });
          // Without a thread, the session cannot continue. A rejected turn ends that turn.
          if (
            pending?.method === 'initialize' ||
            pending?.method === 'thread/start' ||
            pending?.method === 'thread/resume'
          )
            stop(child);
          else if (pending?.method === 'turn/start')
            emit({ type: 'turn-end', status: 'failed' });
        } else if (record(message.result)) pending?.onResult?.(message.result);
        return;
      }
      // Codex can report other threads, such as a reviewer, on the same connection.
      const from = str(params.threadId);
      if (thread && from && from !== thread) {
        // Only the transcript shows subagent work. Requests and records stay with the main thread.
        if (method && agents.has(from)) transcribe(method, params.item, from);
        return;
      }
      if (method === 'serverRequest/resolved') {
        const resolved = params.requestId;
        const key =
          typeof resolved === 'number' || typeof resolved === 'string'
            ? `c${resolved}`
            : '';
        if (requests.delete(key)) emit({ type: 'request-end', id: key });
      } else if (method === 'item/started' || method === 'item/completed') {
        transcribe(method, params.item, null);
        item(method, params.item);
      } else if (method === 'turn/completed') {
        turn = undefined;
        const value = record(params.turn) ? str(params.turn.status) : undefined;
        emit({
          type: 'turn-end',
          status:
            value === 'interrupted'
              ? 'interrupted'
              : value === 'failed'
                ? 'failed'
                : 'completed',
        });
      } else if (method === 'item/autoApprovalReview/completed') {
        const toolId = str(params.targetItemId);
        const review = record(params.review) ? params.review : {};
        const action = record(params.action)
          ? str(params.action.command)
          : undefined;
        const risk = str(review.riskLevel);
        const rationale = str(review.rationale);
        if (toolId)
          emit({
            type: 'review',
            toolId,
            approved: review.status === 'approved',
            ...(action ? { action } : {}),
            ...(risk ? { risk } : {}),
            ...(rationale ? { rationale } : {}),
          });
      } else if (method === 'error')
        emit({
          type: 'notice',
          text: `Codex reported an error: ${record(params.error) ? (str(params.error.message) ?? 'unknown') : 'unknown'}.`,
        });
    },
    (text) => emit({ type: 'notice', text }),
  );

  call(
    'initialize',
    {
      clientInfo: {
        name: 'verifold',
        title: 'Verifold',
        version: options.clientVersion,
      },
      capabilities: { experimentalApi: true },
    },
    () => {
      write(child, { method: 'initialized', params: {} });
      call(
        options.resume ? 'thread/resume' : 'thread/start',
        {
          ...(options.resume ? { threadId: options.resume } : {}),
          cwd: options.cwd,
          // A strict task session gets no approvals: an action outside the sandbox fails.
          approvalPolicy: options.mode === 'strict' ? 'never' : 'on-request',
          sandbox: 'workspace-write',
          // Without this, a user's global reviewer setting can answer requests meant for the person.
          approvalsReviewer: options.mode === 'auto' ? 'auto_review' : 'user',
          ...(options.model ? { model: options.model } : {}),
        },
        (result) => {
          thread = record(result.thread) ? str(result.thread.id) : undefined;
          if (!thread) {
            emit({ type: 'notice', text: 'Codex did not start a thread.' });
            stop(child);
            return;
          }
          const model = str(result.model);
          const reviewer = str(result.approvalsReviewer);
          emit({
            type: 'session',
            id: thread,
            ...(model ? { model } : {}),
            ...(reviewer ? { mode: reviewer } : {}),
          });
          // A cancel can arrive before the thread exists. Then the first turn never starts.
          if (cancelled) emit({ type: 'turn-end', status: 'interrupted' });
          else if (options.prompt) startTurn(options.prompt);
        },
      );
    },
  );
  return {
    pid: child.pid,
    send(text) {
      cancelled = false;
      startTurn(text);
    },
    interrupt(pending) {
      for (const id of pending) answer(id, false);
      cancelled = true;
      interruptTurn();
    },
    answer,
    close() {
      child.stdin.end();
      stop(child);
    },
  };
}

export function startHostSession(options: HostOptions): HostSession {
  return options.host === 'claude' ? claude(options) : codex(options);
}
