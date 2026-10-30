import { ShipcastError } from '@shipcast/schema';

/*
 * A file the owner uploads as a launch's source (docs/sources.md). What it is comes from its bytes,
 * never from its name or the type the browser claimed, and only still images are taken: SVG is
 * refused (it can carry script), and so is anything else. The metadata a camera writes (EXIF, with
 * the GPS position of a phone photo, XMP, IPTC, text chunks) is removed before the file is stored,
 * since a launch's media end up public, and so is anything after the picture's end (a motion photo's
 * video, appended after a JPEG's end-of-image marker, can hold sound and the place it was taken).
 */

/** The largest file taken, before anything is read from it */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type UploadMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface SanitisedUpload {
  body: Uint8Array<ArrayBuffer>;
  mime: UploadMime;
  kind: 'image';
  width: number | null;
  height: number | null;
}

/** Why an upload was not taken: the owner's file, so never retried */
export class UploadRefused extends ShipcastError {
  constructor(message: string) {
    super(message, { code: 'invalid', httpStatus: 400 });
  }
}

const starts = (bytes: Uint8Array, prefix: readonly number[], at = 0) => prefix.every((b, i) => bytes[at + i] === b);
const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

/** The type the bytes are, by their signature; undefined for anything that is not one of the images taken */
export function sniffImage(bytes: Uint8Array): UploadMime | undefined {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return undefined;
}

/** Checks, identifies and strips an upload; refuses anything it cannot vouch for */
export function sanitiseUpload(input: Uint8Array): SanitisedUpload {
  if (input.byteLength === 0) throw new UploadRefused('the file is empty');
  if (input.byteLength > MAX_UPLOAD_BYTES) throw new UploadRefused(`the file is ${input.byteLength} bytes; at most ${MAX_UPLOAD_BYTES} are taken`);
  const mime = sniffImage(input);
  if (!mime) throw new UploadRefused('only PNG, JPEG, GIF and WebP images are taken (SVG is not)');
  const body = mime === 'image/png' ? stripPng(input) : mime === 'image/jpeg' ? stripJpeg(input) : mime === 'image/webp' ? stripWebp(input) : stripGif(input);
  const size = dimensions(body, mime);
  return { body, mime, kind: 'image', width: size?.width ?? null, height: size?.height ?? null };
}

const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) + b[at + 1]!;
const u32le = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16) + ((b[at + 3]! << 24) >>> 0);
const u16le = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16);

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** PNG's text, time and EXIF chunks: where a camera or an editor writes about the picture rather than the picture */
const PNG_METADATA = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function stripPng(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= bytes.byteLength) {
    const length = u32be(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    const end = at + 12 + length;
    if (end > bytes.byteLength) throw new UploadRefused('the PNG is cut short');
    if (!PNG_METADATA.has(type)) parts.push(bytes.subarray(at, end));
    at = end;
    if (type === 'IEND') return concat(parts);
  }
  throw new UploadRefused('the PNG has no end');
}

/**
 * JPEG segments up to the image data: APP1 (EXIF and XMP, where the GPS position is), APP12 and
 * APP13 (IPTC, Photoshop) and comments go; APP0 (JFIF), APP2 (the colour profile) and APP14 (Adobe's
 * colour transform) stay, since the picture's colours depend on them.
 */
const JPEG_DROPPED = new Set([0xe1, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xef, 0xfe]);

function stripJpeg(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= bytes.byteLength) {
    if (bytes[at] !== 0xff) throw new UploadRefused('the JPEG is malformed');
    const marker = bytes[at + 1]!;
    // Start of scan: the image data, kept as it is up to the end-of-image marker. Inside the scans a
    // 0xFF byte is always stuffed (FF 00) or a restart or segment marker, so the first FF D9 is the
    // real end; what follows it (a motion photo's video, any appended file) is not the picture and goes
    if (marker === 0xda) {
      // Searched past the scan's own header, whose bytes are parameters, not entropy-coded data
      const end = endOfImage(bytes, at + 2 + u16be(bytes, at + 2));
      if (end === undefined) throw new UploadRefused('the JPEG has no end-of-image marker');
      return concat([...parts, bytes.subarray(at, end)]);
    }
    const end = at + 2 + u16be(bytes, at + 2);
    if (end > bytes.byteLength) throw new UploadRefused('the JPEG is cut short');
    if (!JPEG_DROPPED.has(marker)) parts.push(bytes.subarray(at, end));
    at = end;
  }
  throw new UploadRefused('the JPEG has no image data');
}

/** Where a JPEG's end-of-image marker ends, searching from its first scan; undefined without one */
function endOfImage(bytes: Uint8Array, from: number): number | undefined {
  for (let at = from; at + 1 < bytes.byteLength; at++) if (bytes[at] === 0xff && bytes[at + 1] === 0xd9) return at + 2;
  return undefined;
}

/**
 * The application extensions that only say how an animation repeats: kept, since without them a GIF
 * plays once and stops, and their one sub-block holds a loop count, nothing about the owner. Every
 * other application extension (XMP, editors' own data) goes.
 */
const GIF_LOOPING = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

/**
 * A GIF block by block: comments (FE) and application extensions (FF) other than the looping one go,
 * as does anything after the trailer. The picture's blocks (frames, colour tables, frame timing, the
 * plain text a frame draws) are kept as they are.
 */
function stripGif(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const short = () => new UploadRefused('the GIF is cut short');
  if (bytes.byteLength < 13) throw short();
  const packed = bytes[10]!;
  let at = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  const parts: Uint8Array[] = [bytes.subarray(0, at)];
  /** Where the sub-blocks starting at `from` end, past their zero-length terminator */
  const subBlocksEnd = (from: number) => {
    let p = from;
    for (;;) {
      if (p >= bytes.byteLength) throw short();
      const size = bytes[p]!;
      p += 1 + size;
      if (size === 0) return p;
    }
  };
  for (;;) {
    if (at >= bytes.byteLength) throw new UploadRefused('the GIF has no end');
    const introducer = bytes[at]!;
    if (introducer === 0x3b) return concat([...parts, bytes.subarray(at, at + 1)]);
    if (introducer === 0x21) {
      if (at + 2 > bytes.byteLength) throw short();
      const label = bytes[at + 1]!;
      const end = subBlocksEnd(at + 2);
      const application = label === 0xff && bytes[at + 2] === 11 ? ascii(bytes, at + 3, 11) : undefined;
      const dropped = label === 0xfe || (label === 0xff && !(application !== undefined && GIF_LOOPING.has(application)));
      if (!dropped) parts.push(bytes.subarray(at, end));
      at = end;
    } else if (introducer === 0x2c) {
      if (at + 10 > bytes.byteLength) throw short();
      const local = bytes[at + 9]!;
      // The descriptor, its own colour table, then the LZW code size and the image's sub-blocks
      const data = at + 10 + (local & 0x80 ? 3 * 2 ** ((local & 0x07) + 1) : 0) + 1;
      const end = subBlocksEnd(data);
      parts.push(bytes.subarray(at, end));
      at = end;
    } else throw new UploadRefused('the GIF is malformed');
  }
}

/** WebP's EXIF and XMP chunks go, and the extended header no longer says it has them */
function stripWebp(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const type = ascii(bytes, at, 4);
    const size = u32le(bytes, at + 4);
    const end = at + 8 + size + (size % 2);
    if (at + 8 + size > bytes.byteLength) throw new UploadRefused('the WebP is cut short');
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = new Uint8Array(bytes.subarray(at, Math.min(end, bytes.byteLength)));
      // VP8X flags: bit 3 is EXIF, bit 2 is XMP
      if (type === 'VP8X') chunk[8] = chunk[8]! & ~0b1100;
      chunks.push(chunk);
    }
    at = end;
  }
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(bytes.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, body.byteLength + 4, true);
  return concat([header, body]);
}

/** The picture's size in pixels, from its header; undefined when it cannot be read there */
export function dimensions(bytes: Uint8Array, mime: UploadMime): { width: number; height: number } | undefined {
  if (mime === 'image/png' && bytes.byteLength >= 24) return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  if (mime === 'image/gif' && bytes.byteLength >= 10) return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
  if (mime === 'image/webp') {
    const type = ascii(bytes, 12, 4);
    if (type === 'VP8X' && bytes.byteLength >= 30) return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
    if (type === 'VP8L' && bytes.byteLength >= 25) {
      const bits = u32le(bytes, 21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (type === 'VP8 ' && bytes.byteLength >= 30) return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    return undefined;
  }
  if (mime === 'image/jpeg') {
    let at = 2;
    while (at + 9 <= bytes.byteLength && bytes[at] === 0xff) {
      const marker = bytes[at + 1]!;
      // The start-of-frame markers, but DHT (C4), JPG (C8) and DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16be(bytes, at + 7), height: u16be(bytes, at + 5) };
      at += 2 + u16be(bytes, at + 2);
    }
  }
  return undefined;
}
