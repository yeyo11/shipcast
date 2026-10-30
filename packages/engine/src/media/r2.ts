import { createHmac } from 'node:crypto';
import { assertMediaKey, MediaStoreFailed, mediaKey, sha256Hex, type MediaObject, type MediaStore, type StoredMedia } from './store.ts';

/** A bucket on Cloudflare R2, or any S3-compatible store, and the API token's key pair */
export interface R2Config {
  /** `https://<account id>.r2.cloudflarestorage.com`, without the bucket */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 takes `auto`; another S3-compatible store its own region */
  region?: string;
}

export interface R2Options {
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * The media store on Cloudflare R2, through its S3 API with requests signed by hand (Signature
 * Version 4): four calls on one bucket do not need an SDK. Path-style addresses
 * (`<endpoint>/<bucket>/<key>`), which R2 and other S3-compatible stores all take.
 */
export class R2MediaStore implements MediaStore {
  readonly storage = 'r2';
  readonly #config: R2Config;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(config: R2Config, options: R2Options = {}) {
    this.#config = { ...config, endpoint: config.endpoint.replace(/\/+$/, '') };
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async put(body: Uint8Array, mime: string): Promise<StoredMedia> {
    const sha256 = sha256Hex(body);
    const key = mediaKey(sha256);
    const response = await this.#send('PUT', key, { body, headers: { 'content-type': mime }, payloadHash: sha256 });
    if (!response.ok) throw await failure('PUT', key, response);
    return { key, sha256, bytes: body.byteLength, mime };
  }

  async get(key: string): Promise<MediaObject | undefined> {
    assertMediaKey(key);
    const response = await this.#send('GET', key);
    if (response.status === 404) return undefined;
    if (!response.ok) throw await failure('GET', key, response);
    return { body: new Uint8Array(await response.arrayBuffer()), mime: response.headers.get('content-type') ?? 'application/octet-stream' };
  }

  async has(key: string): Promise<boolean> {
    assertMediaKey(key);
    const response = await this.#send('HEAD', key);
    if (response.status === 404) return false;
    if (!response.ok) throw await failure('HEAD', key, response);
    return true;
  }

  async delete(key: string): Promise<void> {
    assertMediaKey(key);
    const response = await this.#send('DELETE', key);
    // S3 answers 204 whether or not the object was there
    if (!response.ok && response.status !== 404) throw await failure('DELETE', key, response);
  }

  async #send(method: string, key: string, options: { body?: Uint8Array; headers?: Record<string, string>; payloadHash?: string } = {}): Promise<Response> {
    const { endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto' } = this.#config;
    const url = new URL(`${endpoint}/${encodeURIComponent(bucket)}/${key}`);
    const signed = signS3Request({
      method,
      url,
      headers: options.headers ?? {},
      payloadHash: options.payloadHash ?? sha256Hex(''),
      accessKeyId,
      secretAccessKey,
      region,
      now: this.#now(),
    });
    try {
      // A view over a SharedArrayBuffer is no request body: the bytes are copied into a plain one
      return await this.#fetch(url, { method, headers: signed, ...(options.body && { body: new Uint8Array(options.body) }) });
    } catch (error) {
      // The endpoint's host names the storage account: kept in the cause, for the log, out of what a client is answered
      throw new MediaStoreFailed('media store: the store could not be reached', { cause: new Error(`${method} ${key} did not reach ${url.host}`, { cause: error }) });
    }
  }
}

async function failure(method: string, key: string, response: Response): Promise<MediaStoreFailed> {
  // S3's error is XML with a Code; its message can echo the request, so only the code is kept
  const code = /<Code>([^<]{1,80})<\/Code>/.exec(await response.text().catch(() => ''))?.[1];
  return new MediaStoreFailed(`media store: ${method} ${key} answered ${response.status}${code ? ` ${code}` : ''}`, { status: response.status });
}

export interface S3Request {
  method: string;
  url: URL;
  /** Headers to send and sign besides host and the x-amz ones */
  headers: Record<string, string>;
  /** The hex sha256 of the body */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  now: Date;
  service?: string;
}

/** The headers of a request signed with AWS Signature Version 4, as the S3 API (and R2's) checks them */
export function signS3Request(request: S3Request): Record<string, string> {
  const service = request.service ?? 's3';
  const amzDate = request.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: request.url.host,
    'x-amz-content-sha256': request.payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value.trim()])),
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const query = [...request.url.searchParams]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    request.method,
    // S3 signs the path as sent, each segment encoded once
    request.url.pathname.split('/').map((s) => encodeRfc3986(decodeURIComponent(s))).join('/'),
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    signedHeaders,
    request.payloadHash,
  ].join('\n');
  const scope = `${day}/${request.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = [day, request.region, service, 'aws4_request'].reduce<Buffer | string>((k, part) => hmac(k, part), `AWS4${request.secretAccessKey}`);
  const signature = hmac(key, toSign).toString('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
