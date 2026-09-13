/** Parse an explicit TCP port, rejecting malformed and out-of-range values. */
export function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new TypeError('Port must contain only decimal digits.');
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new RangeError('Port must be between 1 and 65535.');
  }
  return port;
}
