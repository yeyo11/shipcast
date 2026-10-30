import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { dimensions, MAX_UPLOAD_BYTES, sanitiseUpload, sniffImage, UploadRefused } from '../src/index.ts';

/*
 * An uploaded source file (launch-sources): what it is comes from its bytes, only still images are
 * taken, and what a camera writes about the picture (EXIF and its GPS position, text chunks, XMP) is
 * gone before it is stored.
 */

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** A PNG chunk; the CRC is not checked by the stripper, so zeros do */
const pngChunk = (type: string, data: number[]) => [...u32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];

function png(extra: number[][] = []): Uint8Array {
  const ihdr = [...u32(3), ...u32(2), 8, 2, 0, 0, 0];
  const idat = [...deflateSync(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk('IHDR', ihdr), ...extra.flat(), ...pngChunk('IDAT', idat), ...pngChunk('IEND', [])]);
}

const GPS = ascii('GPS 40.4168 -3.7038');

function jpeg(): Uint8Array {
  const segment = (marker: number, data: number[]) => [0xff, marker, ((data.length + 2) >> 8) & 255, (data.length + 2) & 255, ...data];
  return new Uint8Array([
    0xff, 0xd8,
    ...segment(0xe0, ascii('JFIF\0')),
    ...segment(0xe1, [...ascii('Exif\0\0'), ...GPS]),
    ...segment(0xe2, ascii('ICC_PROFILE\0')),
    ...segment(0xfe, ascii('a comment')),
    // SOF0: precision, height 480, width 640, one component
    ...segment(0xc0, [8, 0x01, 0xe0, 0x02, 0x80, 1, 1, 0x11, 0]),
    ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]),
    1, 2, 3, 0xff, 0xd9,
  ]);
}

function webp(): Uint8Array {
  const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const chunk = (type: string, data: number[]) => [...ascii(type), ...le32(data.length), ...data, ...(data.length % 2 ? [0] : [])];
  // VP8X: flags with EXIF (bit 3) and XMP (bit 2), canvas 100 × 50 (stored minus one, 24-bit)
  const vp8x = chunk('VP8X', [0b1100, 0, 0, 0, 99, 0, 0, 49, 0, 0]);
  const body = [...ascii('WEBP'), ...vp8x, ...chunk('VP8L', [0x2f, 0, 0, 0, 0]), ...chunk('EXIF', GPS), ...chunk('XMP ', ascii('<x:xmpmeta/>'))];
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body]);
}

const contains = (haystack: Uint8Array, needle: number[]) => Buffer.from(haystack).includes(Buffer.from(needle));

test('an upload is what its bytes are, whatever it is called', () => {
  assert.equal(sniffImage(png()), 'image/png');
  assert.equal(sniffImage(jpeg()), 'image/jpeg');
  assert.equal(sniffImage(new Uint8Array(ascii('GIF89a\x02\x00\x03\x00'))), 'image/gif');
  assert.equal(sniffImage(webp()), 'image/webp');
  assert.equal(sniffImage(new Uint8Array(ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))), undefined);
  assert.equal(sniffImage(new Uint8Array(ascii('%PDF-1.7'))), undefined);
});

test('SVG, other files, empty and oversized uploads are refused', () => {
  assert.throws(() => sanitiseUpload(new Uint8Array(ascii('<svg/>'))), UploadRefused);
  assert.throws(() => sanitiseUpload(new Uint8Array(ascii('#!/bin/sh\nrm -rf /'))), /only PNG, JPEG, GIF and WebP/);
  assert.throws(() => sanitiseUpload(new Uint8Array()), /empty/);
  const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
  big.set(png());
  assert.throws(() => sanitiseUpload(big), /at most/);
});

test('a PNG loses its text, time and EXIF chunks and keeps its picture', () => {
  const original = png([pngChunk('tEXt', ascii('Author\0me')), pngChunk('eXIf', GPS), pngChunk('tIME', [7, 234, 10, 30, 0, 0, 0])]);
  const clean = sanitiseUpload(original);
  assert.equal(clean.mime, 'image/png');
  assert.ok(!contains(clean.body, GPS), 'no GPS left');
  assert.ok(!contains(clean.body, ascii('tEXt')) && !contains(clean.body, ascii('tIME')));
  assert.ok(contains(clean.body, ascii('IDAT')) && contains(clean.body, ascii('IEND')));
  assert.deepEqual([clean.width, clean.height], [3, 2]);
  assert.equal(clean.body.byteLength, png().byteLength, 'what is left is the plain picture');
});

test('a JPEG loses EXIF and comments, and keeps JFIF, its colour profile and its image data', () => {
  const clean = sanitiseUpload(jpeg());
  assert.ok(!contains(clean.body, GPS) && !contains(clean.body, ascii('Exif')));
  assert.ok(!contains(clean.body, ascii('a comment')));
  assert.ok(contains(clean.body, ascii('JFIF')) && contains(clean.body, ascii('ICC_PROFILE')));
  assert.ok(contains(clean.body, [1, 2, 3, 0xff, 0xd9]), 'the scan is untouched');
  assert.deepEqual([clean.width, clean.height], [640, 480]);
});

test('a WebP loses its EXIF and XMP chunks, its header says so and its RIFF size is right', () => {
  const clean = sanitiseUpload(webp());
  assert.ok(!contains(clean.body, GPS) && !contains(clean.body, ascii('XMP ')));
  const flags = clean.body[20]!;
  assert.equal(flags & 0b1100, 0, 'VP8X no longer announces EXIF or XMP');
  assert.equal(new DataView(clean.body.buffer).getUint32(4, true), clean.body.byteLength - 8);
  assert.deepEqual(dimensions(clean.body, 'image/webp'), { width: 100, height: 50 });
});

test('a picture cut short is refused rather than stored half-read', () => {
  assert.throws(() => sanitiseUpload(png().subarray(0, 40)), /cut short|no end/);
  assert.throws(() => sanitiseUpload(jpeg().subarray(0, 30)), /cut short|no image data|malformed/);
});

test('a JPEG ends at its end-of-image marker: what a phone appends after it (a motion photo’s video) goes', () => {
  const video = [...ascii('ftypmp42'), ...GPS];
  const clean = sanitiseUpload(new Uint8Array([...jpeg(), ...video]));
  assert.deepEqual([...clean.body.subarray(-2)], [0xff, 0xd9]);
  assert.ok(!contains(clean.body, ascii('ftypmp42')) && !contains(clean.body, GPS));
  assert.deepEqual(sanitiseUpload(jpeg()).body, sanitiseUpload(new Uint8Array([...jpeg(), ...video])).body);
  // A scan with no end-of-image marker cannot be told from what follows it
  assert.throws(() => sanitiseUpload(jpeg().subarray(0, jpeg().byteLength - 2)), /no end/);
});

/** A GIF89a, 2 × 1, with a global colour table, the looping extension, a comment and an XMP application extension */
function gif(): Uint8Array {
  const subBlocks = (data: number[]) => [data.length, ...data, 0];
  return new Uint8Array([
    ...ascii('GIF89a'),
    2, 0, 1, 0, 0x80, 0, 0,
    0, 0, 0, 255, 255, 255,
    0x21, 0xff, 11, ...ascii('NETSCAPE2.0'), 3, 1, 0, 0, 0,
    0x21, 0xfe, ...subBlocks(ascii('a comment')),
    0x21, 0xff, 11, ...ascii('XMP DataXMP'), ...subBlocks([...ascii('<x:xmpmeta>'), ...GPS]),
    0x21, 0xf9, 4, 0, 10, 0, 0, 0,
    0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0,
    2, 2, 0x4c, 0x01, 0,
    0x3b,
    ...ascii('trailing'),
  ]);
}

test('a GIF loses its comments, its application data and what trails it, and keeps its looping and its frames', () => {
  const clean = sanitiseUpload(gif());
  assert.equal(clean.mime, 'image/gif');
  assert.ok(!contains(clean.body, ascii('a comment')));
  assert.ok(!contains(clean.body, ascii('XMP DataXMP')) && !contains(clean.body, GPS));
  assert.ok(!contains(clean.body, ascii('trailing')));
  assert.ok(contains(clean.body, ascii('NETSCAPE2.0')), 'an animation still loops');
  assert.ok(contains(clean.body, [0x21, 0xf9, 4, 0, 10, 0, 0, 0]), 'the frame timing stays');
  assert.ok(contains(clean.body, [0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0, 0x3b]), 'the frame and the trailer stay');
  assert.deepEqual([clean.width, clean.height], [2, 1]);
  assert.throws(() => sanitiseUpload(gif().subarray(0, 40)), /cut short|no end/);
});
