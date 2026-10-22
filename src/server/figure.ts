import type { OutgoingHttpHeaders } from 'node:http';

/** The pixels of an image that the app shows: each side, and both sides together. */
export const figurePixels = { side: 20_000, total: 50_000_000 };

/**
 * The width and height that an image declares in its header: PNG, GIF,
 * JPEG, or WebP. Null for another type, or for a header that Verifold
 * cannot read. The browser decodes this many pixels, so the API checks them
 * before the app gets the image.
 */
export function imageSize(
  type: string,
  bytes: Buffer,
): { readonly width: number; readonly height: number } | null {
  const ascii = (start: number, end: number): string =>
    bytes.subarray(start, end).toString('latin1');
  if (type === 'image/png')
    return bytes.length >= 24 &&
      bytes.readUInt32BE(0) === 0x89504e47 &&
      ascii(12, 16) === 'IHDR'
      ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
      : null;
  if (type === 'image/gif')
    return bytes.length >= 10 && /^GIF8[79]a$/.test(ascii(0, 6))
      ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
      : null;
  if (type === 'image/webp') {
    if (bytes.length < 30 || ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WEBP')
      return null;
    const chunk = ascii(12, 16);
    if (chunk === 'VP8X')
      return {
        width: bytes.readUIntLE(24, 3) + 1,
        height: bytes.readUIntLE(27, 3) + 1,
      };
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (chunk === 'VP8 ' && bytes.readUIntBE(23, 3) === 0x9d012a)
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    return null;
  }
  if (type === 'image/jpeg') {
    if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null;
    let at = 2;
    while (at + 9 <= bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1] ?? 0;
      // Fill bytes, and markers without a length.
      if (
        marker === 0xff ||
        marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd8)
      ) {
        at += marker === 0xff ? 1 : 2;
        continue;
      }
      // A start of frame: SOF0 to SOF15, but not DHT (C4), JPG (C8), or DAC (CC).
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      )
        return {
          width: bytes.readUInt16BE(at + 7),
          height: bytes.readUInt16BE(at + 5),
        };
      // The image data starts before any frame: the header has no size.
      if (marker === 0xda) return null;
      at += 2 + bytes.readUInt16BE(at + 2);
    }
    return null;
  }
  return null;
}

/**
 * A figure's file name that is safe in a header: its own name with only
 * letters, digits, dots, dashes, and underscores, else `figure` with its
 * extension.
 */
export function figureName(path: string, extension: string): string {
  const name = (path.split('/').at(-1) ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(-100);
  return /^[A-Za-z0-9_-]/.test(name) ? name : `figure.${extension}`;
}

/**
 * The headers of a figure that a post pinned. An agent made its bytes, so
 * as a page of its own it gets no script, no origin, and no loads. A visit
 * to an SVG or a PDF downloads it and never shows it as a page.
 */
export function figureHeaders(
  path: string,
  type: string,
  bytes: number,
): OutgoingHttpHeaders {
  const extension =
    type === 'image/svg+xml' ? 'svg' : (type.split('/')[1] ?? '');
  const download = type === 'image/svg+xml' || type === 'application/pdf';
  return {
    'Content-Type': type,
    'Content-Length': bytes,
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${figureName(path, extension)}"`,
    'Content-Security-Policy':
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
}
