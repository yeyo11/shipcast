import { assertMediaKey, mediaKey, sha256Hex, type MediaObject, type MediaStore, type StoredMedia } from '../media/store.ts';

/** The media store in memory, keyed as R2 keys it, for tests: `objects` shows what was stored */
export class MemoryMediaStore implements MediaStore {
  readonly storage = 'memory';
  readonly objects = new Map<string, MediaObject>();

  async put(body: Uint8Array, mime: string): Promise<StoredMedia> {
    const sha256 = sha256Hex(body);
    const key = mediaKey(sha256);
    this.objects.set(key, { body: new Uint8Array(body), mime });
    return { key, sha256, bytes: body.byteLength, mime };
  }

  async get(key: string): Promise<MediaObject | undefined> {
    assertMediaKey(key);
    const found = this.objects.get(key);
    return found && { body: new Uint8Array(found.body), mime: found.mime };
  }

  async has(key: string): Promise<boolean> {
    assertMediaKey(key);
    return this.objects.has(key);
  }

  async delete(key: string): Promise<void> {
    assertMediaKey(key);
    this.objects.delete(key);
  }
}
