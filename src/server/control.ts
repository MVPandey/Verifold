import { createConnection, createServer, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The channel between a terminal and the background owner of a project: a
 * Unix socket and a key. The key never goes into a command line, an
 * environment variable, a project file, or a log. The owner keeps it in
 * `~/.verifold/credentials/owners/`, which strict workers and the coordinator
 * cannot read.
 */
export interface Control {
  readonly socket: string;
  readonly token: string;
}

/** From the owner: a status line, the desk URL (with its access token), or the end. */
export type FromOwner =
  | { readonly progress: string }
  /** The desk's URL with its token, and the new app's URL when the package has its build. */
  | { readonly url: string; readonly app?: string }
  | { readonly stopped: true };

/** From a terminal, after the key: a line that the person typed, or stop. */
export type ToOwner = { readonly line: string } | { readonly stop: true };

/** One message. A status line can hold the terminal help or a long agent reply. */
const maxLine = 64 * 1024;

/** A new key, and a socket in a private temporary folder. Socket paths on macOS have at most about 104 bytes. */
export async function newControl(): Promise<Control> {
  const folder = await mkdtemp(join(tmpdir(), 'vf-'));
  return {
    socket: join(folder, 'owner.sock'),
    token: randomBytes(32).toString('hex'),
  };
}

/** Remove the private folder of a socket from `newControl`. */
export async function removeSocket(control: Control): Promise<void> {
  await rm(dirname(control.socket), { recursive: true, force: true });
}

/** The control of a project owner, from the first line of its input. */
export function parseControl(value: unknown): Control | null {
  if (typeof value !== 'object' || value === null) return null;
  const { socket, token } = value as Record<string, unknown>;
  return typeof socket === 'string' &&
    socket.length > 0 &&
    socket.length < 200 &&
    typeof token === 'string' &&
    /^[0-9a-f]{64}$/.test(token)
    ? { socket, token }
    : null;
}

/**
 * Save the control of an owner as a `0600` file in `keys` (`0700`). Returns
 * the function that removes it.
 * ponytail: an owner that was killed leaves its small file behind. Clean up by owner ID if the folder grows.
 */
export async function saveControl(
  keys: string,
  ownerId: string,
  control: Control,
): Promise<() => Promise<void>> {
  await mkdir(keys, { recursive: true, mode: 0o700 });
  const path = join(keys, `${ownerId}.json`);
  await writeFile(path, JSON.stringify(control), { mode: 0o600 });
  return () => rm(path, { force: true });
}

/** The saved control of an owner, or null when it has none. */
export async function readControl(
  keys: string,
  ownerId: string,
): Promise<Control | null> {
  if (!/^[0-9a-f-]{36}$/.test(ownerId)) return null;
  try {
    return parseControl(
      JSON.parse(await readFile(join(keys, `${ownerId}.json`), 'utf8')),
    );
  } catch {
    return null;
  }
}

/** Read newline-delimited JSON from a socket. A line over the limit, or a line that is not JSON, closes it. */
function readLines(socket: Socket, onMessage: (value: unknown) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      onMessage(value);
      if (socket.destroyed) return;
      end = buffer.indexOf('\n');
    }
    if (buffer.length > maxLine) socket.destroy();
  });
  // A closed peer is normal. The close event reports it.
  socket.on('error', () => {});
}

function write(socket: Socket, value: FromOwner | ToOwner): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

function sameKey(given: unknown, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ControlServer {
  /** Send a message to every terminal that gave the key. */
  send(message: FromOwner): void;
  close(): Promise<void>;
}

/**
 * Listen on the socket of `control`. A terminal must send the key first,
 * within `keyWait` ms, or the owner closes the connection. `attached` gets the
 * function that sends to the new terminal only.
 */
export async function serveControl(
  control: Control,
  handlers: {
    readonly attached: (send: (message: FromOwner) => void) => void;
    readonly message: (message: ToOwner) => void;
  },
  keyWait = 2000,
): Promise<ControlServer> {
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    let known = false;
    const late = setTimeout(() => socket.destroy(), keyWait);
    socket.on('close', () => {
      clearTimeout(late);
      clients.delete(socket);
    });
    readLines(socket, (value) => {
      const message = (value ?? {}) as Record<string, unknown>;
      if (!known) {
        clearTimeout(late);
        if (!sameKey(message.token, control.token)) {
          socket.destroy();
          return;
        }
        known = true;
        clients.add(socket);
        handlers.attached((reply) => write(socket, reply));
      } else if (typeof message.line === 'string' && message.line.length < 8000)
        handlers.message({ line: message.line });
      else if (message.stop === true) handlers.message({ stop: true });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(control.socket, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    send: (message) => {
      for (const socket of clients) write(socket, message);
    },
    close: async () => {
      // Each terminal reads the last messages before its connection ends.
      for (const socket of clients) socket.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export interface ControlClient {
  send(message: ToOwner): void;
  close(): void;
  /** Settles when the owner or this client closes the connection. */
  readonly closed: Promise<void>;
}

/** Connect to an owner and give its key. Rejects when nothing listens on the socket. */
export async function connectControl(
  control: Control,
  onMessage: (message: FromOwner) => void,
): Promise<ControlClient> {
  const socket = createConnection(control.socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve();
    });
  });
  const closed = new Promise<void>((resolve) => socket.on('close', resolve));
  readLines(socket, (value) => {
    const message = (value ?? {}) as Record<string, unknown>;
    if (typeof message.progress === 'string')
      onMessage({ progress: message.progress });
    else if (typeof message.url === 'string')
      onMessage({
        url: message.url,
        ...(typeof message.app === 'string' ? { app: message.app } : {}),
      });
    else if (message.stopped === true) onMessage({ stopped: true });
  });
  socket.write(`${JSON.stringify({ token: control.token })}\n`);
  return {
    send: (message) => write(socket, message),
    close: () => socket.end(),
    closed,
  };
}
