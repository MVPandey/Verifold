'use strict';
// A WebSocket server on a Unix socket, for fake Codex app-servers in tests. It
// reads the socket path from `--listen unix://PATH` and offers the same `out`
// and line handler that the fakes used with stdio.
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');

module.exports = function serve(argv) {
  const listen = argv[argv.indexOf('--listen') + 1] || '';
  const path = listen.replace(/^unix:\/\//, '');
  const handlers = [];
  const waiting = [];
  let client = null;
  const send = (text) => {
    const payload = Buffer.from(text);
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
    else if (payload.length < 65536)
      header = Buffer.from([
        0x81,
        126,
        payload.length >> 8,
        payload.length & 255,
      ]);
    else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const data = Buffer.concat([header, payload]);
    if (client) client.write(data);
    else waiting.push(data);
  };
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let open = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!open) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString();
        const key = (/sec-websocket-key: (.*)/i.exec(head) || [])[1] || '';
        const accept = crypto
          .createHash('sha1')
          .update(`${key.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        open = true;
        buffer = buffer.subarray(end + 4);
        client = socket;
        for (const data of waiting.splice(0)) socket.write(data);
      }
      while (buffer.length >= 2) {
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const mask =
          buffer[1] & 0x80 ? buffer.subarray(offset, offset + 4) : null;
        if (mask) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (mask)
          for (let index = 0; index < payload.length; index++)
            payload[index] ^= mask[index % 4];
        const opcode = buffer[0] & 0x0f;
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x8) socket.end();
        else if (opcode === 0x1)
          for (const handler of handlers) handler(payload.toString());
      }
    });
  });
  fs.rmSync(path, { force: true });
  server.listen(path);
  return {
    out: (value) => send(JSON.stringify(value)),
    onLine: (handler) => handlers.push(handler),
  };
};
