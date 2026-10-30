import { ShipcastError, type Brand } from '@shipcast/schema';
import { articleConfig, articleSlug } from '../article.ts';
import { MediaStoreFailed, mediaKey, type MediaStore } from '../media/store.ts';
import type { Launch, LaunchRepository, LaunchSourceRepository, NewLaunchSource, SourceMedia } from '../repositories/index.ts';
import { channelsText } from '../sources/draft.ts';
import { checkSources, InvalidSources, primaryRepoOf, type SourceInput, type SourcesLaunchInput } from '../sources/model.ts';
import type { PageFetcher } from '../sources/pages.ts';
import { sanitiseUpload } from '../sources/upload.ts';
import { LaunchRefused, type LaunchService } from './launches.ts';

export interface SourcesServiceDeps {
  /** The manual claim of a repo's release, with its pre-flight: what a launch with a primary repo is claimed by */
  launchService: Pick<LaunchService, 'claimManual'>;
  launches: Pick<LaunchRepository, 'claim' | 'setStatus' | 'setModelFields'>;
  sources: Pick<LaunchSourceRepository, 'replace' | 'recordUpload' | 'upload' | 'attach'>;
  /** Where a launch with no repo lives, like an article: its blog and its drafts' folder */
  readonly launchesRepo: string;
  media: MediaStore;
  /** The guarded fetcher every page goes through */
  fetchPage: PageFetcher;
  /**
   * Where the particulars of a refused page or a failed store go: the client is answered in general
   * words (they could map the server's network or name the storage account), the log keeps the rest
   */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** An error's message and those of its causes, for the log */
function detailOf(error: unknown): string {
  const lines: string[] = [];
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) lines.push(e.message);
  return lines.join(': ');
}

/**
 * A launch made from sources (launch-sources, docs/sources.md), the one way the app and the REST
 * API make one: its sources checked, its pages fetched, its uploads taken from the media store, and
 * the launch claimed once. With a primary repo the launch is that repo's release, claimed by hand
 * as any release is (its pre-flight, its launch.yml), so the release can never launch twice; with
 * none it is claimed like an article, under its title's slug. Drafting is the `draft` job's, which
 * the caller queues with the launch this answers.
 */
export class SourcesService {
  readonly #deps: SourcesServiceDeps;

  constructor(deps: SourcesServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Takes an uploaded file into the media store: identified by its bytes, its metadata stripped,
   * kept under its sha256. Answers the media row a launch's `media` source names by that sha256.
   */
  async upload(bytes: Uint8Array): Promise<SourceMedia> {
    const file = sanitiseUpload(bytes);
    let stored: Awaited<ReturnType<MediaStore['put']>>;
    try {
      stored = await this.#deps.media.put(file.body, file.mime);
    } catch (error) {
      if (error instanceof MediaStoreFailed) this.#deps.log?.('an upload could not be stored', { detail: detailOf(error) });
      throw error;
    }
    return this.#deps.sources.recordUpload({
      sha256: stored.sha256,
      kind: file.kind,
      mime: file.mime,
      bytes: stored.bytes,
      width: file.width,
      height: file.height,
      storage: this.#deps.media.storage,
      path: stored.key,
    });
  }

  /** Claims a launch made from the sources given and records them; refused (LaunchRefused) with what is wrong */
  async create(input: SourcesLaunchInput, brand: Brand): Promise<Launch> {
    try {
      checkSources(input);
    } catch (error) {
      if (error instanceof InvalidSources) throw new LaunchRefused('invalid', error.message);
      throw error;
    }
    const title = input.title.trim();
    // Everything that can be refused is read before the claim, so a refused page never burns one
    const rows = await this.#rows(input.sources);
    const primary = primaryRepoOf(input.sources);
    const launch = primary ? await this.#claimRelease(primary, title, brand) : await this.#claimWithoutRepo(input, title, brand);
    try {
      const recorded: NewLaunchSource[] = [];
      for (const { row, upload } of rows) {
        // The release claimed is the primary repo's ref: the latest one when none was named
        if (row.role === 'primary') recorded.push({ ...row, ref: launch.ref });
        // The launch owns its own media row for the upload; the stored bytes stay shared by their key
        else if (upload) recorded.push({ ...row, mediaId: (await this.#deps.sources.attach(launch.id, upload)).id });
        else recorded.push(row);
      }
      await this.#deps.sources.replace(launch.id, recorded);
    } catch (error) {
      // A failed launch can be asked for again; one left `detected` with no sources could not
      await this.#deps.launches.setStatus(launch.id, 'failed', `its sources could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    return launch;
  }

  async #claimRelease(primary: Extract<SourceInput, { kind: 'repo' }>, title: string, brand: Brand): Promise<Launch> {
    const { launch } = await this.#deps.launchService.claimManual(primary.repo, primary.ref, async () => brand);
    await this.#deps.launches.setModelFields(launch.id, { title, channelsSource: null });
    return launch;
  }

  async #claimWithoutRepo(input: SourcesLaunchInput, title: string, brand: Brand): Promise<Launch> {
    const slug = articleSlug(title);
    if (!slug) throw new LaunchRefused('invalid', 'the title needs letters or digits: it becomes the article’s address');
    const channelsSource = channelsText(articleConfig(brand, input.channels), brand);
    const claim = await this.#deps.launches.claim({ repo: this.#deps.launchesRepo, ref: `article:${slug}`, trigger: 'manual', kind: 'launch', brand: brand.id, title, channelsSource });
    if (claim.claimed) return claim.launch;
    if (claim.launch.status !== 'failed') throw new LaunchRefused('launched', `A launch or article titled like this exists already (${claim.launch.status}). Change the title.`, claim.launch);
    await this.#deps.launches.setModelFields(claim.launch.id, { title, channelsSource });
    return this.#deps.launches.setStatus(claim.launch.id, 'detected', `retried after: ${claim.launch.detail?.split('\n')[0] ?? 'a failure'}`);
  }

  /** Each source as its row: pages fetched, uploads found, the primary repo marked */
  async #rows(sources: readonly SourceInput[]): Promise<Array<{ row: NewLaunchSource; upload?: SourceMedia }>> {
    const primary = primaryRepoOf(sources);
    const rows: Array<{ row: NewLaunchSource; upload?: SourceMedia }> = [];
    for (const source of sources) {
      if (source.kind === 'text') {
        rows.push({ row: { kind: 'text', role: 'context', text: source.text.trim(), meta: source.title ? { title: source.title } : {} } });
      } else if (source.kind === 'url') {
        try {
          rows.push({ row: await this.#deps.fetchPage(source.url) });
        } catch (error) {
          if (error instanceof ShipcastError) {
            this.#deps.log?.('a source page was not read', { url: source.url, detail: detailOf(error) });
            throw new LaunchRefused('invalid', `${source.url} could not be read: ${error.message}`);
          }
          throw error;
        }
      } else if (source.kind === 'repo') {
        const isPrimary = source === primary;
        rows.push({ row: { kind: isPrimary ? 'repo_release' : source.ref ? 'repo_ref' : 'repo', role: isPrimary ? 'primary' : 'context', repo: source.repo, ref: source.ref ?? null } });
      } else {
        const upload = await this.#deps.sources.upload(source.sha256);
        if (!upload) throw new LaunchRefused('invalid', `no uploaded file has the sha256 ${source.sha256.slice(0, 12)}…: upload it first`);
        if (!(await this.#deps.media.has(mediaKey(upload.sha256)))) throw new LaunchRefused('invalid', `the file ${source.sha256.slice(0, 12)}… is no longer in the media store: upload it again`);
        rows.push({ row: { kind: 'media', role: 'context', meta: { ...(source.name && { name: source.name }), ...(source.alt && { alt: source.alt }) } }, upload });
      }
    }
    return rows;
  }
}
