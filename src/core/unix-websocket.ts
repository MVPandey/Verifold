import { createConnection, type Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

/**
 * A minimal WebSocket client over a Unix socket, for the Codex app-server.
 * Text messages only. It answers pings, joins fragments, and closes on any
 * message above the size limit. Node has a WebSocket client, but it cannot
 * connect to a Unix socket.
 */
export interface UnixWebSocket {
  send(text: string): void;
  close(): void;
}

/** One protocol message can be large, for example a tool result. */
const maxMessage = 8 * 1024 * 1024;

function frame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff])
        : Buffer.concat([
            Buffer.from([0x80 | opcode, 0x80 | 127]),
            (() => {
              const size = Buffer.alloc(8);
              size.writeBigUInt64BE(BigInt(length));
              return size;
            })(),
          ]);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index++)
    masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  return Buffer.concat([header, mask, masked]);
}

/**
 * Connect and finish the WebSocket handshake. `onMessage` gets each text
 * message. `onClose` runs once, when either side closes or the socket fails.
 */
export function connectUnixWebSocket(
  path: string,
  onMessage: (text: string) => void,
  onClose: (reason: string) => void,
): Promise<UnixWebSocket> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(path);
    const key = randomBytes(16).toString('base64');
    let open = false;
    let closed = false;
    let buffer = Buffer.alloc(0);
    let parts: Buffer[] = [];
    let partSize = 0;
    const finish = (reason: string): void => {
      if (closed) return;
      closed = true;
      socket.destroy();
      if (open) onClose(reason);
      else reject(new Error(reason));
    };
    const client: UnixWebSocket = {
      send(text) {
        if (!closed) socket.write(frame(0x1, Buffer.from(text, 'utf8')));
      },
      close() {
        if (closed) return;
        socket.write(frame(0x8, Buffer.alloc(0)));
        finish('closed by Verifold');
      },
    };
    const read = (): void => {
      while (buffer.length >= 2) {
        const first = buffer[0] ?? 0;
        const second = buffer[1] ?? 0;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const size = buffer.readBigUInt64BE(2);
          if (size > BigInt(maxMessage)) return finish('message too large');
          length = Number(size);
          offset = 10;
        }
        // A server does not mask its frames. A masked frame is a protocol error.
        if (second & 0x80) return finish('masked server frame');
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        const opcode = first & 0x0f;
        if (opcode === 0x8) {
          socket.write(frame(0x8, Buffer.alloc(0)));
          return finish('closed by Codex');
        }
        if (opcode === 0x9) {
          socket.write(frame(0xa, payload));
          continue;
        }
        if (opcode === 0xa) continue;
        if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) continue;
        partSize += payload.length;
        if (partSize > maxMessage) return finish('message too large');
        parts.push(Buffer.from(payload));
        if (first & 0x80) {
          const message = Buffer.concat(parts).toString('utf8');
          parts = [];
          partSize = 0;
          if (opcode !== 0x2) onMessage(message);
        }
      }
    };
    socket.on('connect', () =>
      socket.write(
        `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!open) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buffer.length > 16_384) finish('handshake too large');
          return;
        }
        const head = buffer.subarray(0, end).toString('latin1');
        const accept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        if (
          !/^HTTP\/1\.1 101 /.test(head) ||
          !head
            .toLowerCase()
            .includes(`sec-websocket-accept: ${accept.toLowerCase()}`)
        )
          return finish(`handshake failed: ${head.split('\r\n')[0] ?? ''}`);
        open = true;
        buffer = buffer.subarray(end + 4);
        resolve(client);
      }
      read();
    });
    socket.on('error', (error) => finish(error.message));
    socket.on('close', () => finish('socket closed'));
  });
}
