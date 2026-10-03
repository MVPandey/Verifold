import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectUnixWebSocket } from '../src/cli/unix-websocket.ts';

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

async function server(
  t: test.TestContext,
  onOpen: (socket: Socket, received: () => Buffer) => void,
  accept = true,
): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'vf-ws-'));
  const path = join(folder, 'test.sock');
  const listener = createServer((socket) => {
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
  });
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
