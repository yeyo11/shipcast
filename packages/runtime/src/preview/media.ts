import { assertMediaKey, mediaKey, sha256Hex, type MediaObject, type MediaStore, type StoredMedia } from '@shipcast/engine';

/**
 * A preview's media store when it has no bucket: the files kept in the process's memory, gone when
 * it stops. Only for a preview with fake networks (preview/guard.ts), so an image can be uploaded and
 * seen in the editor without reaching the real bucket.
 */
export class PreviewMediaStore implements MediaStore {
  readonly storage = 'preview-memory';
  readonly #objects = new Map<string, MediaObject>();

  async put(body: Uint8Array, mime: string): Promise<StoredMedia> {
    const sha256 = sha256Hex(body);
    const key = mediaKey(sha256);
    this.#objects.set(key, { body: new Uint8Array(body), mime });
    return { key, sha256, bytes: body.byteLength, mime };
  }

  async get(key: string): Promise<MediaObject | undefined> {
    assertMediaKey(key);
    return this.#objects.get(key);
  }

  async has(key: string): Promise<boolean> {
    assertMediaKey(key);
    return this.#objects.has(key);
  }

  async delete(key: string): Promise<void> {
    assertMediaKey(key);
    this.#objects.delete(key);
  }
}
