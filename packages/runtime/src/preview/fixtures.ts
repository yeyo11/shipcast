import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';

/*
 * Files a preview serves in place of GitHub and the brand's site, for launches that exist only in
 * the preview (the scale test's): their pack, their launch.yml and article in the repos GitHub would
 * hold them in, and their launch image on the site. A folder shared by every replica
 * (SHIPCAST_PREVIEW_FIXTURES), laid out as
 *
 *   github/<owner>/<repo>/<path>     what GET /repos/<owner>/<repo>/contents/<path> answers, at any ref
 *   site/<host>/<path>               what GET or HEAD https://<host>/<path> answers
 *
 * A site folder that exists is the fixtures' own: a file missing from it answers 404 here, so a launch
 * the preview made up never sends a request to the owner's real site. Anything else goes on as it would.
 */

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.html': 'text/html',
};

const typeOf = (path: string) => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

export class PreviewFixtures {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** A path under the root, or undefined for one that would leave it (`..`, an absolute part) */
  #under(...parts: string[]): string | undefined {
    const segments = parts.flatMap((p) => p.split('/')).filter((s) => s !== '');
    if (segments.some((s) => s === '..' || s === '.' || s.includes('\\') || s.includes('\0'))) return undefined;
    const path = resolve(this.root, ...segments);
    return path === this.root || path.startsWith(this.root + sep) ? path : undefined;
  }

  #file(path: string | undefined): Uint8Array<ArrayBuffer> | undefined {
    if (!path || !existsSync(path) || !statSync(path).isFile()) return undefined;
    return new Uint8Array(readFileSync(path));
  }

  /** A file of a repo as GitHub's contents API would give it, at any ref */
  github(repo: string, path: string): Uint8Array<ArrayBuffer> | undefined {
    return this.#file(this.#under('github', repo, path));
  }

  /** What the site answers for a URL: a file, a 404 in a folder of the fixtures, or undefined when the URL is not theirs */
  site(url: URL): { status: 200; body: Uint8Array<ArrayBuffer>; type: string } | { status: 404 } | undefined {
    const path = this.#under('site', url.host, decodeURIComponent(url.pathname));
    if (!path) return undefined;
    const body = this.#file(path);
    if (body) return { status: 200, body, type: typeOf(path) };
    const folder = dirname(path);
    return folder.startsWith(this.#under('site', url.host) ?? '\0') && existsSync(folder) && statSync(folder).isDirectory() ? { status: 404 } : undefined;
  }

  writeGitHub(repo: string, path: string, content: string | Uint8Array): void {
    this.#write(this.#under('github', repo, path), content);
  }

  writeSite(url: string, content: string | Uint8Array): void {
    const parsed = new URL(url);
    this.#write(this.#under('site', parsed.host, decodeURIComponent(parsed.pathname)), content);
  }

  #write(path: string | undefined, content: string | Uint8Array): void {
    if (!path) throw new Error('a fixture path must stay inside the fixtures folder');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/** The fixtures of this process, when SHIPCAST_PREVIEW_FIXTURES names a folder */
export function previewFixtures(env: NodeJS.ProcessEnv = process.env): PreviewFixtures | undefined {
  const dir = env.SHIPCAST_PREVIEW_FIXTURES?.trim();
  return dir ? new PreviewFixtures(dir) : undefined;
}

const methodOf = (input: string | URL | Request, init: RequestInit | undefined) => (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
const urlOf = (input: string | URL | Request) => new URL(input instanceof Request ? input.url : String(input));

/** GitHub's contents reads answered from the fixtures where they have the file; everything else goes to `next` */
export function withGitHubFixtures(fixtures: PreviewFixtures | undefined, next: typeof fetch): typeof fetch {
  if (!fixtures) return next;
  return async (input, init) => {
    const method = methodOf(input, init);
    const url = urlOf(input);
    const match = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(url.pathname);
    if ((method === 'GET' || method === 'HEAD') && match) {
      const body = fixtures.github(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!));
      if (body) return new Response(method === 'HEAD' ? null : body, { status: 200, headers: { 'content-type': 'application/vnd.github.raw' } });
    }
    return next(input, init);
  };
}

/** The site's reads answered from the fixtures where the folder is theirs; everything else goes to `next` */
export function withSiteFixtures(fixtures: PreviewFixtures | undefined, next: typeof fetch): typeof fetch {
  if (!fixtures) return next;
  return async (input, init) => {
    const method = methodOf(input, init);
    if (method === 'GET' || method === 'HEAD') {
      const found = fixtures.site(urlOf(input));
      if (found?.status === 404) return new Response(null, { status: 404 });
      if (found) return new Response(method === 'HEAD' ? null : found.body, { status: 200, headers: { 'content-type': found.type, 'content-length': String(found.body.byteLength) } });
    }
    return next(input, init);
  };
}
