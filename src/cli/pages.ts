import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { extname, posix } from 'node:path';

/**
 * Pages that agents make, served on their own loopback origin, so that a page
 * cannot reach the desk's page, storage, or token. A page runs no scripts and
 * loads nothing from the network: a probe in Chrome 155 showed that a page with
 * scripts can always reach the network (WebRTC, or navigating its own frame),
 * and that `<link rel=prerender>` and `<link rel=preconnect>` reach it without
 * scripts, outside CSP. See issue #204.
 */
export interface PageServer {
  readonly origin: string;
  /** The URL of one file of a version. It works while the desk runs, until 30 minutes pass without a request. */
  grant(task: string, version: number, path: string): string;
}

/** One file of a version's task folder, or null when it is missing or larger than `pageFileLimit`. */
export type PageReader = (
  task: string,
  version: number,
  path: string,
) => Promise<Buffer | null>;

export const pageFileLimit = 20 * 1024 * 1024;
const idleLimit = 30 * 60_000;
const grantLimit = 100;

const text = 'text/plain; charset=utf-8';
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': text,
  '.csv': text,
  '.json': text,
  '.md': text,
};

/** The CSP of every page file. `sandbox` holds also when the page opens in its own tab. */
function policy(desk: string): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    `frame-ancestors ${desk}`,
    // A link that the person clicks opens in a new tab, outside the sandbox, as a link in an agent's reply does.
    'sandbox allow-popups allow-popups-to-escape-sandbox',
  ].join('; ');
}

/**
 * Make every `<link` and `<meta` tag inert. A resource hint reaches the network
 * outside CSP, and a meta tag could turn DNS prefetch back on. A namespace
 * prefix counts too, for XHTML inside an SVG file. The bytes are read as
 * Latin-1, so other bytes stay as they are.
 */
export function defuse(body: Buffer): Buffer {
  return Buffer.from(
    body
      .toString('latin1')
      .replace(
        /<(\/?)((?:[^\t\n\f\r />:="'<]+:)?)(link|meta)(?=[\t\n\f\r />])/gi,
        '<$1$2x-$3',
      ),
    'latin1',
  );
}

/** A UTF-16 byte order mark makes the browser decode the page past the rewrite. */
function utf16(body: Buffer): boolean {
  return (
    body.length >= 2 &&
    ((body[0] === 0xfe && body[1] === 0xff) ||
      (body[0] === 0xff && body[1] === 0xfe))
  );
}

/** A relative path inside the task folder, without `.` or `..` parts. */
function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 300 &&
    !path.startsWith('/') &&
    !/[\\\0]/.test(path) &&
    posix.normalize(path) === path &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

/** Start the page server, on `port` when it is free. It stops when the signal aborts. */
export async function startPageServer(
  desk: string,
  read: PageReader,
  signal: AbortSignal,
  port = 0,
): Promise<PageServer> {
  const grants = new Map<
    string,
    { readonly task: string; readonly version: number; used: number }
  >();
  let origin = '';
  const server = createServer((request, response) => {
    respond(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.maxConnections = 20;
  server.setTimeout(10000, (socket) => socket.destroy());

  async function respond(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader('Content-Security-Policy', policy(desk));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-DNS-Prefetch-Control', 'off');
    // The Host check keeps DNS rebinding out.
    if (request.headers.host !== origin.slice(7)) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const [, key = '', ...parts] = new URL(
      request.url ?? '/',
      origin,
    ).pathname.split('/');
    const grant = grants.get(key);
    let path = '';
    try {
      path = parts.map(decodeURIComponent).join('/');
    } catch {
      /* A path that does not decode is not found. */
    }
    const type = types[extname(path).toLowerCase()];
    if (
      !grant ||
      grant.used + idleLimit < Date.now() ||
      !validPath(path) ||
      !type
    ) {
      response.writeHead(404).end();
      return;
    }
    grant.used = Date.now();
    const file = await read(grant.task, grant.version, path);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    const markup = type.startsWith('text/html') || type === 'image/svg+xml';
    if (markup && utf16(file)) {
      response
        .writeHead(415, { 'Content-Type': text })
        .end('Verifold shows pages in UTF-8 only.');
      return;
    }
    const body = markup ? defuse(file) : file;
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  const listen = async (at: number): Promise<void> => {
    const listening = once(server, 'listening');
    server.listen(at, '127.0.0.1');
    await listening;
  };
  await listen(port).catch(() => listen(0));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not start the page server.');
  }
  origin = `http://127.0.0.1:${address.port}`;
  const stop = (): void => {
    server.closeAllConnections();
    server.close();
  };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  return {
    origin,
    grant: (task, version, path) => {
      const now = Date.now();
      let key = '';
      for (const [existing, entry] of grants)
        if (entry.used + idleLimit < now) grants.delete(existing);
        else if (entry.task === task && entry.version === version)
          key = existing;
      if (!key) {
        key = randomBytes(32).toString('hex');
        grants.set(key, { task, version, used: now });
        // The oldest grant goes first. A Map keeps insertion order.
        if (grants.size > grantLimit)
          grants.delete(grants.keys().next().value ?? '');
      } else {
        const entry = grants.get(key);
        if (entry) entry.used = now;
      }
      return `${origin}/${key}/${path.split('/').map(encodeURIComponent).join('/')}`;
    },
  };
}
