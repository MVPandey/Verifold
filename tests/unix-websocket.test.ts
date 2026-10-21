import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  connectUnixWebSocket,
  connectWhenListening,
} from '../src/core/unix-websocket.ts';

/** A server frame: never masked. `fin` false starts or continues a fragmented message. */
function frame(opcode: number, payload: Buffer, fin = true): Buffer {
  const length = payload.length;
  const first = (fin ? 0x80 : 0) | opcode;
  if (length < 126)
    return Buffer.concat([Buffer.from([first, length]), payload]);
  if (length < 65_536)
    return Buffer.concat([
      Buffer.from([first, 126, length >> 8, length & 255]),
      payload,
    ]);
  const header = Buffer.alloc(10);
  header[0] = first;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

/** Decode the client's masked frames. */
function frames(data: Buffer): { opcode: number; text: string }[] {
  const found: { opcode: number; text: string }[] = [];
  let buffer = data;
  while (buffer.length >= 2) {
    let length = (buffer[1] ?? 0) & 0x7f;
    let offset = 2;
    if (length === 126) {
      length = buffer.readUInt16BE(2);
      offset = 4;
    }
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    for (let index = 0; index < payload.length; index++)
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    found.push({ opcode: (buffer[0] ?? 0) & 0x0f, text: payload.toString() });
    buffer = buffer.subarray(offset + length);
  }
  return found;
}

/** The server side of the handshake: accept (or refuse) the upgrade, then hand the socket over. */
function upgrade(
  onOpen: (socket: Socket, received: () => Buffer) => void,
  accept = true,
): (socket: Socket) => void {
  return (socket) => {
    let data = Buffer.alloc(0);
    let open = false;
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (open) return;
      const end = data.indexOf('\r\n\r\n');
      if (end < 0) return;
      const key =
        /sec-websocket-key: (.*)/i
          .exec(data.subarray(0, end).toString())?.[1]
          ?.trim() ?? '';
      const value = createHash('sha1')
        .update(`${accept ? key : 'wrong'}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${value}\r\n\r\n`,
      );
      open = true;
      data = data.subarray(end + 4);
      onOpen(socket, () => data);
    });
  };
}

async function server(
  t: test.TestContext,
  onOpen: (socket: Socket, received: () => Buffer) => void,
  accept = true,
): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'vf-ws-'));
  const path = join(folder, 'test.sock');
  const listener = createServer(upgrade(onOpen, accept));
  await new Promise<void>((resolve) => listener.listen(path, resolve));
  t.after(async () => {
    listener.close();
    await rm(folder, { recursive: true, force: true });
  });
  return path;
}

await test('the client answers pings, joins fragments, and sends masked text', async (t) => {
  let peer: { socket: Socket; received: () => Buffer } | undefined;
  const path = await server(t, (socket, received) => {
    peer = { socket, received };
    socket.write(frame(0x9, Buffer.from('ping data')));
    socket.write(frame(0x1, Buffer.from('{"part":'), false));
    socket.write(frame(0x0, Buffer.from('"one"}')));
    socket.write(frame(0x1, Buffer.from('x'.repeat(70_000))));
  });
  const messages: string[] = [];
  const client = await connectUnixWebSocket(
    path,
    (text) => messages.push(text),
    () => {},
  );
  client.send('{"method":"initialize"}');
  for (let tries = 0; tries < 100 && messages.length < 2; tries++)
    await delay(10);
  assert.deepEqual(messages[0], '{"part":"one"}');
  assert.equal(messages[1]?.length, 70_000);
  await delay(50);
  const sent = frames(peer?.received() ?? Buffer.alloc(0));
  assert.deepEqual(sent, [
    { opcode: 0xa, text: 'ping data' },
    { opcode: 0x1, text: '{"method":"initialize"}' },
  ]);
  client.close();
});

await test('an oversized message or a close from the server ends the connection once', async (t) => {
  const path = await server(t, (socket) => {
    // Claims 9 MiB. The client stops before reading it.
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(9 * 1024 * 1024), 2);
    socket.write(header);
  });
  const reasons: string[] = [];
  await connectUnixWebSocket(
    path,
    () => {},
    (reason) => reasons.push(reason),
  );
  for (let tries = 0; tries < 100 && !reasons.length; tries++) await delay(10);
  assert.deepEqual(reasons, ['message too large']);

  const closing = await server(t, (socket) =>
    socket.write(frame(0x8, Buffer.alloc(0))),
  );
  const ended: string[] = [];
  await connectUnixWebSocket(
    closing,
    () => {},
    (reason) => ended.push(reason),
  );
  for (let tries = 0; tries < 100 && !ended.length; tries++) await delay(10);
  assert.deepEqual(ended, ['closed by Codex']);
});

await test('a wrong handshake or a missing socket fails the connection', async (t) => {
  const path = await server(t, () => {}, false);
  await assert.rejects(
    connectUnixWebSocket(
      path,
      () => {},
      () => {},
    ),
    /handshake failed/,
  );
  await assert.rejects(
    connectUnixWebSocket(
      join(tmpdir(), 'vf-missing.sock'),
      () => {},
      () => {},
    ),
    /ENOENT|ECONNREFUSED/,
  );
});

// A starting server's socket file can appear before the server accepts (#247).
await test('a client waits for a server that is still starting, while its process lives', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'vf-ws-'));
  const path = join(folder, 'test.sock');
  const listener = createServer(
    upgrade((socket) => socket.write(frame(0x1, Buffer.from('ready')))),
  );
  t.after(async () => {
    listener.close();
    await rm(folder, { recursive: true, force: true });
  });
  // The path exists, but nothing listens at it yet: one try fails.
  await writeFile(path, '');
  await assert.rejects(
    connectUnixWebSocket(
      path,
      () => {},
      () => {},
    ),
  );
  const messages: string[] = [];
  const waiting = connectWhenListening(
    path,
    { alive: () => true, deadline: Date.now() + 10_000 },
    (text) => messages.push(text),
    () => {},
  );
  await delay(300);
  await rm(path);
  await new Promise<void>((resolve) => listener.listen(path, resolve));
  const client = await waiting;
  for (let tries = 0; tries < 100 && !messages.length; tries++) await delay(10);
  assert.deepEqual(messages, ['ready']);
  client.close();
});

await test('a client stops waiting when the process ends or the deadline passes', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'vf-ws-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'test.sock');
  let alive = true;
  const ended = connectWhenListening(
    path,
    { alive: () => alive, deadline: Date.now() + 60_000 },
    () => {},
    () => {},
  );
  await delay(100);
  alive = false;
  await assert.rejects(ended, /No socket at/);
  // A path that holds no server fails after the deadline with the last error.
  await writeFile(path, '');
  const started = Date.now();
  await assert.rejects(
    connectWhenListening(
      path,
      { alive: () => true, deadline: Date.now() + 300 },
      () => {},
      () => {},
    ),
    /ENOENT|ECONNREFUSED|ENOTSOCK/,
  );
  assert.ok(Date.now() - started >= 250);
});
