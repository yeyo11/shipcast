import { createHash } from 'node:crypto';
import { ShipcastError } from '@shipcast/schema';

/*
 * The media store (docs/media-store.md): where a launch's files live once Shipcast, not the launches
 * repo, holds a launch (docs/decisions/launch-model.md). Files are kept by their content: the key is
 * the sha256 of the bytes, so the same file stored twice is one object, and a `media` row names the
 * key with what describes the file. Nothing calls it yet; the phases after the schema do.
 */

/** A file in the store, as `put` answers it */
export interface StoredMedia {
  /** Where the bytes are, `media/<first two hex>/<sha256>`: what `media.path` records */
  key: string;
  sha256: string;
  bytes: number;
  mime: string;
}

export interface MediaObject {
  body: Uint8Array;
  mime: string;
}

/** The port: one implementation per backend (Cloudflare R2 in production), and a fake in memory for tests */
export interface MediaStore {
  /** The backend's name, as `media.storage` records it */
  readonly storage: string;
  /** Keeps the bytes under their sha256; storing the same bytes again changes nothing */
  put(body: Uint8Array, mime: string): Promise<StoredMedia>;
  /** The file under a key, or undefined when the store has none */
  get(key: string): Promise<MediaObject | undefined>;
  has(key: string): Promise<boolean>;
  /** Removes the file; a key with nothing under it is not an error */
  delete(key: string): Promise<void>;
}

const KEY = /^media\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

export function sha256Hex(body: Uint8Array | string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The key a file's bytes are kept under, from their sha256 */
export function mediaKey(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new MediaKeyInvalid(sha256);
  return `media/${sha256.slice(0, 2)}/${sha256}`;
}

/** Refuses anything that is not a key `mediaKey` made, so a caller can never reach another object of the bucket */
export function assertMediaKey(key: string): void {
  const match = KEY.exec(key);
  if (!match || !match[2]!.startsWith(match[1]!)) throw new MediaKeyInvalid(key);
}

export class MediaKeyInvalid extends ShipcastError {
  constructor(key: string) {
    super(`not a media key: ${JSON.stringify(key.slice(0, 120))}`, { code: 'invalid', httpStatus: 400 });
  }
}

/**
 * The media store cannot be used as this process is configured: its flag is off, or its settings
 * are missing from .env. Only the owner fixes it, so it is never retried.
 */
export class MediaStoreUnavailable extends ShipcastError {
  constructor(reason: string) {
    super(`the media store is not available: ${reason}`, { code: 'media_unavailable', httpStatus: 503 });
  }
}

/** The backend answered with a failure, or could not be reached */
export class MediaStoreFailed extends ShipcastError {
  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    const retryable = options.status === undefined || options.status === 429 || options.status >= 500;
    super(message, { code: 'upstream', retryable, httpStatus: 502, ...(options.cause !== undefined && { cause: options.cause }) });
  }
}

/** The store of a process that has none: every call refuses with the reason, rather than failing somewhere later */
export function unavailableMediaStore(reason: string): MediaStore {
  const refuse = async (): Promise<never> => {
    throw new MediaStoreUnavailable(reason);
  };
  return { storage: 'none', put: refuse, get: refuse, has: refuse, delete: refuse };
}
