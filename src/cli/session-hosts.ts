import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectUnixWebSocket, type UnixWebSocket } from './unix-websocket.ts';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { harnessEnvironment, type HarnessName } from './harness.ts';
import {
  claudeUpdates,
  codexAppUpdates,
  type TranscriptUpdate,
} from './transcript.ts';

/**
 * `strict`: a task session. The harness itself limits writes to the task folder and asks nothing.
 * `coordinator`: the coordinator. Claude Code gets no built-in tools; Codex gets a read-only sandbox.
 * Its actions go only through Verifold's tools.
 */
export type SessionMode = 'ask' | 'auto' | 'strict' | 'coordinator';

/** A domain that a task's shell commands may reach: a host name, or `*.` and a domain. */
export function validDomain(value: string): boolean {
  return /^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
    value,
  );
}

/**
 * Claude Code settings for a strict task session: shell commands run in the
 * sandbox, file tools may edit only the working folder, and dontAsk mode
 * denies the rest. The sandbox blocks the network for shell commands, except
 * the task's domains. Probed on Claude Code 2.1.288 and 2.1.289.
 */
export function strictClaudeSettings(domains: readonly string[] = []): string {
  return JSON.stringify({
    // Edit(./**) and Write(./**) resolve against Claude Code's current folder. See strictClaudeEnvironment.
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      ...(domains.length ? { network: { allowedDomains: domains } } : {}),
    },
    permissions: {
      allow: ['Edit(./**)', 'Write(./**)', 'WebSearch', 'WebFetch'],
    },
  });
}

/**
 * The environment of a strict Claude Code session. Claude Code keeps the
 * folder of a Bash `cd` for later tool calls, and the allow rules above then
 * resolve against it, so a worker that ran `cd sub` was denied every write
 * elsewhere in its task folder. This setting returns the shell to the task
 * folder after each command. Probed on Claude Code 2.1.288.
 */
export const strictClaudeEnvironment = {
  CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
} as const;

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

/** One of Verifold's own tools for an agent. */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Verifold's tools for one agent, over the pipe that Verifold owns: an SDK MCP
 * server for Claude Code, dynamic tools for Codex. The pipe identifies the
 * agent, so `call` never trusts a name in the input. `callId` is the harness's
 * ID of the call, so a repeated call can be recognized.
 */
export interface AgentTools {
  readonly specs: readonly AgentTool[];
  readonly call: (
    name: string,
    input: unknown,
    callId: string,
  ) => Promise<{ readonly ok: boolean; readonly text: string }>;
}

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
  readonly tools?: AgentTools;
  /** A strict task: the domains that its shell commands may reach. Codex cannot limit domains, so any domain opens its network. */
  readonly network?: readonly string[];
  readonly onEvent: (event: HostEvent) => void;
}

/** One live harness process. Every method is safe to call after the process exits. */
export interface HostSession {
  /** The harness process. It leads its own process group on POSIX. */
  readonly pid: number | undefined;
  /** Codex only: the app-server socket that a terminal can attach to. */
  readonly socket?: string;
  /** Codex only: `-c` overrides that keep the user's MCP servers, plugins, and apps off in a terminal. */
  readonly overrides?: readonly string[];
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

/**
 * Codex thread settings that load none of the user's MCP servers, plugins, or
 * connected apps, from the `config/read` result. An empty `mcp_servers` table
 * does not replace the user's servers, so each one is turned off by name.
 * Probed on Codex 0.160.0. Without a readable configuration, undefined.
 */
function codexIsolation(result: unknown): Record<string, unknown> | undefined {
  if (!record(result) || !record(result.config)) return undefined;
  const servers = result.config.mcp_servers ?? {};
  if (!record(servers)) return undefined;
  return {
    features: { plugins: false, apps: false },
    mcp_servers: Object.fromEntries(
      Object.keys(servers).map((name) => [name, { enabled: false }]),
    ),
  };
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
    env: {
      ...harnessEnvironment(),
      ...(options.host === 'claude' && options.mode === 'strict'
        ? strictClaudeEnvironment
        : {}),
    },
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
      // Workers load no MCP server from the user's configuration, plugins, or claude.ai connectors.
      '--strict-mcp-config',
      '--permission-mode',
      options.mode === 'auto'
        ? 'auto'
        : options.mode === 'strict'
          ? 'dontAsk'
          : 'default',
      ...(options.mode === 'strict'
        ? ['--settings', strictClaudeSettings(options.network)]
        : []),
      ...(options.mode === 'coordinator' ? ['--tools', ''] : []),
      ...(options.model ? ['--model', options.model] : []),
      ...(options.tools
        ? [
            '--mcp-config',
            JSON.stringify({
              mcpServers: { verifold: { type: 'sdk', name: 'verifold' } },
            }),
            // Verifold's own tools need no permission request.
            '--allowedTools',
            options.tools.specs
              .map((tool) => `mcp__verifold__${tool.name}`)
              .join(','),
          ]
        : []),
      ...(options.resume
        ? ['--resume', options.resume]
        : options.sessionId
          ? ['--session-id', options.sessionId]
          : []),
    ],
    options,
  );
  const emit = options.onEvent;
  const tools = options.tools;
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
        } else if (
          event.request.subtype === 'mcp_message' &&
          event.request.server_name === 'verifold' &&
          tools
        )
          mcp(id, event.request.message);
        else
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
  /** Answer one message to Verifold's SDK MCP server. */
  const mcp = (id: string, message: unknown): void => {
    const reply = (response: Record<string, unknown>): void =>
      write(child, {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: id,
          response: { mcp_response: { jsonrpc: '2.0', ...response } },
        },
      });
    if (!record(message) || !tools) return;
    const rpc = message.id;
    const params = record(message.params) ? message.params : {};
    if (typeof rpc !== 'number' && typeof rpc !== 'string')
      reply({ id: 0, result: {} });
    else if (message.method === 'initialize')
      reply({
        id: rpc,
        result: {
          protocolVersion: str(params.protocolVersion) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'verifold', version: options.clientVersion },
        },
      });
    else if (message.method === 'tools/list')
      reply({ id: rpc, result: { tools: tools.specs } });
    else if (message.method === 'tools/call') {
      const meta = record(params._meta) ? params._meta : {};
      void tools
        .call(
          str(params.name) ?? '',
          params.arguments,
          str(meta['claudecode/toolUseId']) ?? `mcp-${rpc}`,
        )
        .catch(() => ({ ok: false, text: 'Verifold could not run this tool.' }))
        .then((result) =>
          reply({
            id: rpc,
            result: {
              content: [{ type: 'text', text: result.text }],
              isError: !result.ok,
            },
          }),
        );
    } else
      reply({
        id: rpc,
        error: { code: -32601, message: 'Verifold does not support this.' },
      });
  };

  write(child, {
    type: 'control_request',
    request_id: `verifold-${randomUUID()}`,
    request: {
      subtype: 'initialize',
      ...(tools ? { sdkMcpServers: ['verifold'] } : {}),
    },
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
 * Runs the Codex app-server and stops it when its stdin closes. With a socket,
 * the app-server itself ignores stdin, so it would outlive a Verifold that
 * crashed. The watchdog and Codex share one process group, so a later owner
 * can stop both. A missing Codex exits with code 127.
 */
const watchdog = `const { spawn } = require('node:child_process');
const [command, ...args] = process.argv.slice(1);
const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => { try { child.kill('SIGTERM'); } catch {} setTimeout(() => process.exit(0), 2000).unref(); };
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
process.on('SIGTERM', stop);
child.on('error', () => process.exit(127));
child.on('exit', (code) => process.exit(code ?? 1));`;

/**
 * Codex through `codex app-server` (JSON-RPC over stdio). Ask me routes
 * approvals to this client. Auto routes them to the Codex reviewer agent.
 */
function codex(options: HostOptions): HostSession {
  // The app-server listens on a socket in a private folder, so a terminal can attach later.
  // Unix socket paths are short (about 104 bytes on macOS), so the folder is under the temporary folder.
  const folder = mkdtempSync(join(tmpdir(), 'vf-'));
  const socket = join(folder, 'codex.sock');
  const child = launch(
    process.execPath,
    [
      '-e',
      watchdog,
      options.executable ?? 'codex',
      'app-server',
      '--listen',
      `unix://${socket}`,
    ],
    options,
  );
  child.stdout.resume();
  child.on('close', () => rmSync(folder, { recursive: true, force: true }));
  const emit = options.onEvent;
  // `exit` comes before `close`, which reports the end of the session, so the reason comes first.
  child.on('exit', () => {
    if (!connection)
      emit({
        type: 'notice',
        text: 'Could not start Codex. Check that it is installed and signed in.',
      });
  });
  /** Messages wait here until the socket connects. */
  let queue: string[] | null = [];
  let connection: UnixWebSocket | null = null;
  const send = (value: unknown): void => {
    const text = JSON.stringify(value);
    if (connection) connection.send(text);
    else queue?.push(text);
  };
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
  let overrides: string[] = [];
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
    send({ method, id, params });
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
    send({
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
                value.error ||
                value.success === false
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
    } else if (value.type === 'dynamicToolCall') {
      // One of Verifold's own tools.
      if (started)
        emit({
          type: 'tool',
          id,
          tool: str(value.tool) ?? 'Verifold tool',
          action: JSON.stringify(value.arguments ?? {}),
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

  const handle = (message: unknown): void => {
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
      } else if (method === 'item/tool/call' && options.tools)
        void options.tools
          .call(
            str(params.tool) ?? '',
            params.arguments,
            str(params.callId) ?? key,
          )
          .catch(() => ({
            ok: false,
            text: 'Verifold could not run this tool.',
          }))
          .then((result) =>
            send({
              id: rpcId,
              result: {
                contentItems: [{ type: 'inputText', text: result.text }],
                success: result.ok,
              },
            }),
          );
      else {
        send({
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
          pending?.method === 'config/read' ||
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
  };
  // Connect when the socket appears. A server that never listens counts as a failed start.
  void (async () => {
    for (let tries = 0; tries < 300 && !existsSync(socket); tries++) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      connection = await connectUnixWebSocket(
        socket,
        (text) => {
          let message: unknown;
          try {
            message = JSON.parse(text);
          } catch {
            emit({
              type: 'notice',
              text: 'Verifold could not read one message from Codex.',
            });
            return;
          }
          handle(message);
        },
        () => stop(child),
      );
      for (const text of queue ?? []) connection.send(text);
      queue = null;
    } catch {
      emit({
        type: 'notice',
        text: 'Could not connect to Codex. Check that it is installed and signed in.',
      });
      stop(child);
    }
  })();

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
      send({ method: 'initialized', params: {} });
      call('config/read', { cwd: options.cwd }, (result) => {
        const config = codexIsolation(result);
        if (config)
          overrides = [
            '-c',
            'features.plugins=false',
            '-c',
            'features.apps=false',
            ...Object.keys(
              config.mcp_servers as Record<string, unknown>,
            ).flatMap((name) => [
              '-c',
              `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}.enabled=false`,
            ]),
            ...(options.network?.length
              ? ['-c', 'sandbox_workspace_write.network_access=true']
              : []),
          ];
        if (!config) {
          emit({
            type: 'notice',
            text: 'Codex did not report its configuration, so Verifold cannot turn off its MCP servers. The session stopped.',
          });
          stop(child);
          return;
        }
        startThread(config);
      });
    },
  );

  /** Start or resume the thread with the configuration that turns off the user's MCP servers. */
  function startThread(config: Record<string, unknown>): void {
    call(
      options.resume ? 'thread/resume' : 'thread/start',
      {
        ...(options.resume ? { threadId: options.resume } : {}),
        cwd: options.cwd,
        // A strict task session and the coordinator get no approvals: an action outside the sandbox fails.
        approvalPolicy:
          options.mode === 'strict' || options.mode === 'coordinator'
            ? 'never'
            : 'on-request',
        sandbox:
          options.mode === 'coordinator' ? 'read-only' : 'workspace-write',
        // Without this, a user's global reviewer setting can answer requests meant for the person.
        approvalsReviewer: options.mode === 'auto' ? 'auto_review' : 'user',
        ...(options.model ? { model: options.model } : {}),
        // Dynamic tools stay with the thread, and `thread/resume` does not take them. Probed on Codex 0.160.0.
        ...(options.tools && !options.resume
          ? {
              dynamicTools: options.tools.specs.map((tool) => ({
                type: 'function',
                ...tool,
              })),
            }
          : {}),
        config: options.network?.length
          ? { ...config, sandbox_workspace_write: { network_access: true } }
          : config,
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
  }
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
      connection?.close();
      stop(child);
    },
    socket,
    get overrides() {
      return overrides;
    },
  };
}

export function startHostSession(options: HostOptions): HostSession {
  return options.host === 'claude' ? claude(options) : codex(options);
}
