import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deskPage, renderDesk } from './desk-view.ts';
import {
  readDeskSnapshot,
  readDeskReport,
  validAttemptId,
} from './desk-records.ts';
import type { ResearchReport } from './research.ts';

export interface DeskServer {
  readonly url: string;
  readonly closed: Promise<void>;
}

/** Serve one selected project until its owning CLI is cancelled. */
export async function startDesk(
  root: string,
  signal: AbortSignal,
  assetsRoot: URL = new URL('./', import.meta.url),
): Promise<DeskServer> {
  signal.throwIfAborted();
  root = await realpath(root);
  await readDeskSnapshot(root);
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  const assets = new Map<string, { type: string; body: Buffer | string }>([
    ['/', { type: 'text/html; charset=utf-8', body: deskPage }],
  ]);
  for (const [path, file, type] of [
    ['/desk.css', 'desk.css', 'text/css; charset=utf-8'],
    ['/desk-client.js', 'desk-client.js', 'text/javascript; charset=utf-8'],
    ['/manrope.ttf', 'manrope.ttf', 'font/ttf'],
    ['/symbol.webp', 'symbol.webp', 'image/webp'],
    ['/ui/dom.js', '../ui/dom.js', 'text/javascript; charset=utf-8'],
  ] as const) {
    assets.set(path, { type, body: await readFile(new URL(file, assetsRoot)) });
  }
  let origin = '';
  let pending = 0;
  const server = createServer(
    { maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 },
    (request, response) => {
      void respond(request, response).catch(() => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            error:
              'Project records could not be read. Inspect the selected workspace and refresh.',
          }),
        );
      });
    },
  );
  server.maxConnections = 20;
  server.setTimeout(10000, (socket) => socket.destroy());

  async function respond(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (
      request.headers.host !== origin.slice(7) ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== origin) ||
      (request.headers['sec-fetch-site'] !== undefined &&
        request.headers['sec-fetch-site'] !== 'same-origin' &&
        request.headers['sec-fetch-site'] !== 'none')
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    const url = new URL(request.url ?? '/', origin);
    const asset = assets.get(url.pathname);
    if (asset && !url.search) {
      response.writeHead(200, { 'Content-Type': asset.type }).end(asset.body);
      return;
    }
    if (url.pathname !== '/api/view') {
      response.writeHead(404).end();
      return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (
      supplied.length !== authorization.length ||
      !timingSafeEqual(supplied, authorization)
    ) {
      response.writeHead(401).end();
      return;
    }
    const selected = url.searchParams.get('attempt') ?? undefined;
    if (
      (selected !== undefined && !validAttemptId(selected)) ||
      [...url.searchParams.keys()].some((key) => key !== 'attempt') ||
      url.searchParams.getAll('attempt').length > 1
    ) {
      response.writeHead(400).end();
      return;
    }
    if (pending >= 4) {
      response.writeHead(503).end();
      return;
    }
    pending++;
    try {
      const snapshot = await readDeskSnapshot(root);
      const id =
        selected ??
        snapshot.workspace.research?.latestAttempt ??
        snapshot.attempts[0]?.id;
      if (
        selected &&
        !snapshot.attempts.some((attempt) => attempt.id === selected)
      ) {
        response.writeHead(404).end();
        return;
      }
      let report: ResearchReport | null = null;
      if (id) {
        try {
          report = await readDeskReport(root, id);
        } catch {
          /* Missing or unsafe reports remain unavailable. */
        }
      }
      const body = JSON.stringify(renderDesk(snapshot, selected, report));
      if (Buffer.byteLength(body) > 2_000_000)
        throw new Error('Desk view exceeds its output limit.');
      response
        .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(body);
    } finally {
      pending--;
    }
  }

  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not start the local desk.');
  }
  origin = `http://127.0.0.1:${address.port}`;
  const stop = (): void => {
    server.closeAllConnections();
    server.close();
  };
  const closed = once(server, 'close').then(() => {
    signal.removeEventListener('abort', stop);
  });
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  return { url: `${origin}/#${token}`, closed };
}

/** Browser launch is optional. The printed URL remains usable if it fails. */
export async function openDeskBrowser(
  url: string,
  signal: AbortSignal,
  executable?: string,
): Promise<boolean> {
  const command =
    executable ??
    (process.platform === 'darwin'
      ? 'open'
      : process.platform === 'linux'
        ? 'xdg-open'
        : undefined);
  if (!command) return false;
  try {
    await promisify(execFile)(command, [url], {
      timeout: 3000,
      maxBuffer: 8192,
      signal,
    });
    return true;
  } catch {
    return false;
  }
}
