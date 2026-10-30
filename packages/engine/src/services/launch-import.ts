import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CHANNELS, parseBrand, parseFrontMatter, pullRequestNumber, ShipcastError, type Brand, type Channel } from '@shipcast/schema';
import { isArticle, launchDir, projectSlug } from '../drafts.ts';
import type { GitHubSource, TreeFile } from '../github.ts';
import { dedupeKeyOf, draftOfPiece, gitBlobSha, importedChannels, readLaunchYml, readPack, type CapturedArticleInput } from '../launch-import.ts';
import { channelRows, channelsAsLaunchYml, mediaKind, mimeOf, RELEASE_NOTES, storedFile } from '../launch-store.ts';
import { sha256Hex, type MediaStore, type StoredMedia } from '../media/store.ts';
import { cancelledKey, launchConfigText, publishLaunch, type ChannelPublishing, type Publishers, type PublishResult } from '../publish.ts';
import { failureKey } from '../publishing/retry.ts';
import type { CapturedLaunch, ChannelRow, ImportedColumns, Launch, LaunchCounts, Repositories, SourceInput } from '../repositories/index.ts';

/*
 * The import of the launches drafted before Shipcast held them (docs/launch-import.md, phase 3 of
 * docs/decisions/launch-model.md). It reads each launch's drafts pull request and the launches
 * repo's main branch at one commit (GitHub, read only) and Postgres, and writes the launch model's
 * rows as the shadow write would have: the pack, the channel rows, every draft as versions (the pull
 * request's, then main's where it changed after the merge), the media, the merge as the approval.
 * Every channel that never published is turned off. The launches decided away are deleted, kept
 * whole in the batch log. Plan, apply, verify and roll back: one implementation, a thin script.
 */

/** The GitHub reads of the import, all of them GETs */
export interface ImportGitHub extends Pick<GitHubSource, 'fileAt'> {
  commitSha(repo: string, ref: string): Promise<string>;
  tree(repo: string, sha: string): Promise<TreeFile[]>;
  blob(repo: string, sha: string): Promise<Uint8Array>;
  pullRequest(repo: string, number: number): Promise<{ url: string; state: 'open' | 'merged' | 'closed'; headSha: string; mergedBy: string | null; mergedAt: string | null }>;
  pullRequestFiles(repo: string, number: number): Promise<string[]>;
}

/** Publishers and strategies that never reach a network: each call is recorded in `calls` and refused */
export interface DryPublishing {
  publishers: Publishers;
  strategies: Record<string, ChannelPublishing>;
  calls: string[];
}

export interface LaunchImportDeps {
  registry: Repositories;
  /** Runs `work` in one transaction with every repository over it (`inTransaction`, from the composition root) */
  inTransaction<T>(work: (tx: Repositories) => Promise<T>): Promise<T>;
  github: ImportGitHub;
  media: MediaStore;
  launchesRepo: string;
  /** The owner's article inputs kept outside the database (a capture of BullMQ's jobs); pg-boss's are read from it */
  inputs?: readonly CapturedArticleInput[];
  /** Fresh dry publishers for each launch the verification runs publishing on */
  dryPublishing: () => DryPublishing;
  /** The `launch-import` flag: off, the import plans and verifies but never writes */
  writable: boolean;
}

/** One version of a draft as the import writes it; `fields` says where it was read */
export interface VersionPlan {
  body: string;
  fields: { path: string; blob: string; commit: string; from: 'pull request' | 'main' | 'pull request and main' };
  /** The pack it came with: the index in the launch's packs */
  pack: number | undefined;
}

export interface DraftPlan {
  channel: string;
  piece: string;
  versions: VersionPlan[];
  /** The version the merge approved, an index in `versions` */
  approved: number;
}

export interface MediaPlan {
  path: string;
  publicPath: string;
  role: string;
  shared: boolean;
  blob: string;
  bytes: Uint8Array;
}

export interface LaunchPlan {
  launch: Launch;
  action: 'import' | 'delete' | 'skip';
  /** Why a launch is skipped or deleted */
  reason?: string;
  title?: string | null;
  dedupeKey?: string | null;
  source?: SourceInput;
  channels?: { source: string; rows: ChannelRow[]; turnedOff: string[] };
  packs: Array<{ pack: Record<string, unknown>; from: string }>;
  drafts: DraftPlan[];
  media: MediaPlan[];
  approval?: { by: string; at?: string; note: string };
  /** Published pieces and the draft each came from */
  posts: Array<{ postId: number; channel: string; kind: string; piece: string | undefined }>;
  /** The pull request's head, when the drafts came through one */
  head?: string;
  notes: string[];
}

export interface ImportPlan {
  /** The launches repo's main branch, the commit every launch was read at */
  at: string;
  launches: LaunchPlan[];
}

export interface Verification {
  batch: string;
  /** One line per check that held */
  passed: string[];
  problems: string[];
}

/** The import may not write: the `launch-import` flag is off, or the media store is not there */
export class ImportRefused extends ShipcastError {
  constructor(message: string) {
    super(message, { code: 'state', httpStatus: 409 });
  }
}

const ARTICLE = /^src\/content\/posts\/(en|es)\/([^/]+)\.md$/;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A transaction that ran only to be undone: what publishing would have done is carried out of it */
class DryRun extends Error {
  readonly result: PublishResult;

  constructor(result: PublishResult) {
    super('dry run');
    this.result = result;
  }
}

export class LaunchImportService {
  readonly #deps: LaunchImportDeps;
  readonly #trees = new Map<string, Map<string, TreeFile>>();
  readonly #blobs = new Map<string, Uint8Array>();

  constructor(deps: LaunchImportDeps) {
    this.#deps = deps;
  }

  get #repo() {
    return this.#deps.launchesRepo;
  }

  async #tree(sha: string): Promise<Map<string, TreeFile>> {
    let tree = this.#trees.get(sha);
    if (!tree) {
      tree = new Map((await this.#deps.github.tree(this.#repo, sha)).map((f) => [f.path, f]));
      this.#trees.set(sha, tree);
    }
    return tree;
  }

  async #blob(sha: string): Promise<Uint8Array> {
    let bytes = this.#blobs.get(sha);
    if (!bytes) {
      bytes = await this.#deps.github.blob(this.#repo, sha);
      this.#blobs.set(sha, bytes);
    }
    return bytes;
  }

  /**
   * What the import would do to every launch, read from GitHub and the database and written nowhere:
   * the dry run, and what `apply` writes. `deletions` are the launches decided away; `at` pins the
   * launches repo's main branch (its head now when absent).
   */
  async plan(options: { deletions: readonly number[]; at?: string }): Promise<ImportPlan> {
    const at = options.at ?? (await this.#deps.github.commitSha(this.#repo, 'HEAD'));
    const main = await this.#tree(at);
    const inputs = [...(this.#deps.inputs ?? []), ...(await this.#deps.registry.launchImports.articleInputsFromJobs())];
    const launches = (await this.#deps.registry.launches.recent(100_000)).sort((a, b) => a.id - b.id);
    const plans: LaunchPlan[] = [];
    for (const launch of launches) {
      plans.push(options.deletions.includes(launch.id) ? await this.#planDeletion(launch) : await this.#planImport(launch, main, at, inputs));
    }
    for (const id of options.deletions) {
      if (launches.some((l) => l.id === id)) continue;
      const log = await this.#deps.registry.launchImports.logOf(id);
      plans.push(skipped({ id } as Launch, log ? `deleted already (batch ${log.batch})` : 'no such launch'));
    }
    return { at, launches: plans };
  }

  async #planDeletion(launch: Launch): Promise<LaunchPlan> {
    const { registry } = this.#deps;
    const live = (await registry.posts.posts(launch.id)).filter((p) => p.status !== 'deleted');
    // Deleting is only for launches that never reached anyone: a published piece keeps its launch
    if (live.length > 0) return skipped(launch, `not deleted: ${live.length} piece${live.length === 1 ? ' is' : 's are'} still on a network`);
    if (launch.status === 'published') return skipped(launch, 'not deleted: it is published');
    if (await registry.launchImports.holds(launch.id)) return skipped(launch, 'not deleted: the launch model holds rows of it');
    return { ...empty(launch), action: 'delete', reason: `${launch.status}${launch.detail ? `: ${launch.detail.split('\n')[0]}` : ''}` };
  }

  async #planImport(launch: Launch, main: Map<string, TreeFile>, at: string, inputs: readonly CapturedArticleInput[]): Promise<LaunchPlan> {
    const { registry, github } = this.#deps;
    const log = await registry.launchImports.logOf(launch.id);
    if (log) return skipped(launch, `imported already (batch ${log.batch})`);
    if (await registry.launchImports.holds(launch.id)) return skipped(launch, 'held by the shadow write already');

    const plan: LaunchPlan = { ...empty(launch), action: 'import' };
    const dir = launchDir(launch);
    const number = pullRequestNumber(launch);
    const pr = number ? await github.pullRequest(this.#repo, number) : undefined;
    const direct = /^direct:([0-9a-f]+)/.exec(launch.detail ?? '')?.[1];
    // The drafts a launch has: its pull request's head unless closed unmerged, and main once they landed there
    const head = pr && pr.state !== 'closed' ? await this.#tree(pr.headSha) : undefined;
    const landed = pr?.state === 'merged' || direct !== undefined;
    const onMain = landed ? main : undefined;
    if (pr && head) plan.head = pr.headSha;
    if (!head && !onMain) plan.notes.push(pr ? `its pull request was closed without merging: no drafts imported` : 'no drafts: it never reached a pull request');
    const prFiles = pr ? new Set(await github.pullRequestFiles(this.#repo, number!)) : new Set<string>();

    // The pack: the pull request's, then main's where it changed after the merge
    const packAt = async (tree: Map<string, TreeFile> | undefined) => {
      const entry = tree?.get(`${dir}/pack.json`);
      return entry ? (JSON.parse(text(await this.#blob(entry.sha))) as Record<string, unknown>) : undefined;
    };
    const headPack = await packAt(head);
    const mainPack = await packAt(onMain);
    if (headPack) plan.packs.push({ pack: headPack, from: 'pull request' });
    if (mainPack && !(headPack && isDeepStrictEqual(headPack, mainPack))) plan.packs.push({ pack: mainPack, from: 'main' });
    const headPackIndex = headPack ? 0 : undefined;
    const currentPackIndex = plan.packs.length > 0 ? plan.packs.length - 1 : undefined;

    // The articles are the pack's slugs; a project's cover only where its pull request carried it
    const slugs = new Set(plan.packs.flatMap(({ pack }) => (['en', 'es'] as const).map((lang) => (pack.article as Record<string, { slug?: string }> | undefined)?.[lang]?.slug).filter((s): s is string => typeof s === 'string')));
    const ours = (path: string) => {
      const article = ARTICLE.exec(path);
      if (article) return slugs.has(article[2]!);
      if (path.startsWith('public/covers/')) return prFiles.has(path);
      return path.startsWith(`${dir}/`) || path.startsWith(`public/${dir}/`);
    };
    const paths = [...new Set([...(head?.keys() ?? []), ...(onMain?.keys() ?? [])])].filter(ours).sort();

    for (const path of paths) {
      const stored = storedFile(launch, path);
      const inHead = head?.get(path);
      const inMain = onMain?.get(path);
      if (onMain && !inMain) {
        plan.notes.push(`${path}: removed from main after the merge, not imported`);
        continue;
      }
      if (stored.kind === 'draft') {
        const versions: VersionPlan[] = [];
        if (inHead) versions.push({ body: text(await this.#blob(inHead.sha)), fields: { path, blob: inHead.sha, commit: pr!.headSha, from: inMain?.sha === inHead.sha ? 'pull request and main' : 'pull request' }, pack: headPackIndex });
        if (inMain && inMain.sha !== inHead?.sha) versions.push({ body: text(await this.#blob(inMain.sha)), fields: { path, blob: inMain.sha, commit: at, from: 'main' }, pack: currentPackIndex });
        plan.drafts.push({ channel: stored.channel, piece: stored.piece, versions, approved: 0 });
      } else if (stored.kind === 'media') {
        const entry = (inMain ?? inHead)!;
        const bytes = await this.#blob(entry.sha);
        if (plan.media.some((m) => !m.shared && !stored.shared && sha256Hex(m.bytes) === sha256Hex(bytes))) plan.notes.push(`${path}: the same bytes as another file of the launch, one media row for both`);
        plan.media.push({ path, publicPath: stored.publicPath, role: stored.role, shared: stored.shared, blob: entry.sha, bytes });
      }
    }

    // The channels: an article's launch.yml travels with its drafts, a release's is the project's at the tag
    const channelsText = isArticle(launch)
      ? await (async () => {
          const entry = (onMain ?? head)?.get(`${dir}/launch.yml`);
          return entry ? text(await this.#blob(entry.sha)) : undefined;
        })()
      : await launchConfigText(github, this.#repo, launch);
    const published = await registry.posts.posts(launch.id);
    const read = channelsText === undefined ? undefined : readLaunchYml(channelsText);
    if (channelsText !== undefined && read) {
      plan.channels = { source: channelsText, ...importedChannels(channelRows(read.config), new Set(published.map((p) => p.channel))) };
      if (read.dropped.length > 0) plan.notes.push(`launch.yml names what today's schema has not, left out of the channel rows: ${read.dropped.join(', ')}`);
    } else {
      plan.notes.push(channelsText === undefined ? 'no launch.yml found: no channel rows' : 'launch.yml does not parse: no channel rows');
    }

    plan.posts = published.map((p) => ({ postId: p.id, channel: p.channel, kind: p.kind, piece: draftOfPiece(p.channel, p.kind, plan.drafts) }));
    for (const p of plan.posts) if (p.piece === undefined && plan.drafts.length > 0) plan.notes.push(`${p.channel} ${p.kind}: no draft found for it`);

    if (pr?.state === 'merged') plan.approval = { by: pr.mergedBy ?? 'pull-request', ...(pr.mergedAt && { at: pr.mergedAt }), note: `merged ${pr.url} (imported)` };
    else if (direct) plan.approval = { by: 'shipcast', note: `committed straight onto main as ${direct} (imported)` };

    const currentPack = currentPackIndex === undefined ? undefined : plan.packs[currentPackIndex]!.pack;
    plan.title = this.#title(launch, plan, currentPack, inputs);
    const key = dedupeKeyOf(launch);
    const holder = await registry.launchImports.dedupeKeyHolder(key);
    if (holder !== undefined && holder !== launch.id) plan.notes.push(`${key}: held by launch ${holder}, no dedupe key set`);
    else plan.dedupeKey = key;
    plan.source = await this.#source(launch, plan, inputs);
    return plan;
  }

  /** The name the app lists it as: an article's title as on the blog in the owner's language, a release's project and version */
  #title(launch: Launch, plan: LaunchPlan, pack: Record<string, unknown> | undefined, inputs: readonly CapturedArticleInput[]): string | null {
    if (!isArticle(launch)) {
      const name = (pack?.project as { name?: string } | undefined)?.name ?? projectSlug(launch.repo);
      return `${name} ${launch.ref}`;
    }
    const input = inputs.find((i) => i.launchId === launch.id)?.input;
    const lang = input?.lang === 'en' ? 'en' : 'es';
    for (const l of [lang, lang === 'es' ? 'en' : 'es']) {
      const article = plan.drafts.find((d) => d.channel === 'blog' && d.piece === `article:${l}`);
      const title = article && parseFrontMatter(article.versions.at(-1)!.body).data.title;
      if (typeof title === 'string') return title;
    }
    return input?.title ?? null;
  }

  /** What the launch is about: the release it announced, or the owner's own text for an article */
  async #source(launch: Launch, plan: LaunchPlan, inputs: readonly CapturedArticleInput[]): Promise<SourceInput | undefined> {
    if (!isArticle(launch)) {
      if (launch.ref.startsWith('public:')) return { position: 1, kind: 'repo', role: 'primary', repo: launch.repo };
      const sha = await this.#deps.github.commitSha(launch.repo, launch.ref).catch(() => undefined);
      if (!sha) plan.notes.push(`${launch.repo}@${launch.ref}: the tag could not be read, its commit is not recorded`);
      return { position: 1, kind: 'repo_release', role: 'primary', repo: launch.repo, ref: launch.ref, sha: sha ?? null };
    }
    const input = inputs.find((i) => i.launchId === launch.id)?.input;
    if (input?.markdown) {
      return { position: 1, kind: 'text', role: 'primary', text: input.markdown, contentHash: sha256Hex(input.markdown), meta: { ...(input.title && { title: input.title }), ...(input.lang && { lang: input.lang }), ...(input.channels && { channels: input.channels }), from: 'the job that drafted it' } };
    }
    // The owner's input is gone with its job: the article as published is the closest record of it
    const lang = 'es';
    const article = plan.drafts.find((d) => d.channel === 'blog' && d.piece === `article:${lang}`) ?? plan.drafts.find((d) => d.channel === 'blog');
    if (!article) {
      plan.notes.push('the owner\'s input was not found and there is no article: no source');
      return undefined;
    }
    plan.notes.push('the owner\'s input was not found: the source is the article as published');
    const body = parseFrontMatter(article.versions.at(-1)!.body).body.trim();
    return { position: 1, kind: 'text', role: 'primary', text: body, contentHash: sha256Hex(body), meta: { lang: article.piece.slice('article:'.length), from: 'the article as published' } };
  }

  /**
   * Writes the plan: one transaction per launch, every row tagged with a new batch, the media put in
   * the store first (content-addressed, so a retry stores nothing twice). Answers the batch, or
   * undefined when every launch was skipped (imported or deleted already): a second run writes nothing.
   */
  async apply(plan: ImportPlan): Promise<string | undefined> {
    if (!this.#deps.writable) throw new ImportRefused('the launch-import flag is off (SHIPCAST_FLAGS): the import only plans');
    const work = plan.launches.filter((l) => l.action !== 'skip');
    if (work.length === 0) return undefined;
    // Not half an import: a launch whose files are missing from the store has nothing to publish them from later
    if (work.some((l) => l.media.length > 0) && this.#deps.media.storage === 'none') {
      throw new ImportRefused('the media store is not available: turn launch-media on with SHIPCAST_MEDIA_* in .env');
    }
    const batch = randomUUID();
    for (const launchPlan of work) {
      if (launchPlan.action === 'delete') await this.#delete(batch, launchPlan);
      else await this.#import(batch, plan.at, launchPlan);
    }
    return batch;
  }

  async #delete(batch: string, plan: LaunchPlan): Promise<void> {
    await this.#deps.inTransaction(async (tx) => {
      const captured = await tx.launchImports.capture(plan.launch.id);
      await tx.launchImports.removeLaunch(plan.launch.id);
      await tx.launchImports.record({ batch, launchId: plan.launch.id, action: 'delete', before: captured as unknown as Record<string, unknown>, summary: { repo: plan.launch.repo, ref: plan.launch.ref, status: plan.launch.status, reason: plan.reason ?? null } });
    });
  }

  async #import(batch: string, at: string, plan: LaunchPlan): Promise<void> {
    const { media } = this.#deps;
    const stored: Array<{ file: MediaPlan; put: StoredMedia }> = [];
    for (const file of plan.media) stored.push({ file, put: await media.put(file.bytes, mimeOf(file.path)) });
    const id = plan.launch.id;
    await this.#deps.inTransaction(async (tx) => {
      const before = (await tx.launchImports.columns(id))!;
      const counts = await tx.launchImports.counts(id);
      const packIds: number[] = [];
      for (const { pack, from } of plan.packs) packIds.push((await tx.launchStore.addPack(id, pack, { aiTask: `import (${from})`, importBatch: batch })).id);
      if (plan.channels) await tx.launchStore.replaceChannels(id, plan.channels.rows, plan.channels.source, batch);
      if (plan.source) await tx.launchStore.addSource(id, { ...plan.source, importBatch: batch });
      const approved: Record<string, number> = {};
      const current = new Map<string, number>();
      for (const draft of plan.drafts) {
        const ids: number[] = [];
        let draftId = 0;
        for (const version of draft.versions) {
          const added = await tx.launchStore.addVersion(id, {
            channel: draft.channel,
            piece: draft.piece,
            body: version.body,
            fields: version.fields,
            origin: 'import',
            packId: version.pack === undefined ? null : packIds[version.pack]!,
            importBatch: batch,
          });
          ids.push(added.versionId);
          draftId = added.draftId;
        }
        approved[String(draftId)] = ids[draft.approved]!;
        current.set(`${draft.channel}\n${draft.piece}`, ids.at(-1)!);
      }
      for (const { file, put } of stored) {
        await tx.launchStore.addMedia({
          launchId: file.shared ? null : id,
          sha256: put.sha256,
          kind: mediaKind(put.mime),
          mime: put.mime,
          bytes: put.bytes,
          storage: media.storage,
          path: put.key,
          role: file.role,
          publicPath: file.publicPath,
          importBatch: batch,
        });
      }
      if (plan.approval) await tx.launchStore.approveOnce(id, { ...plan.approval, versions: approved, importBatch: batch });
      const pairs = plan.posts.flatMap((p) => {
        const versionId = p.piece === undefined ? undefined : current.get(`${p.channel}\n${p.piece}`);
        return versionId === undefined ? [] : [{ postId: p.postId, versionId }];
      });
      const postIds = await tx.launchImports.setPostVersions(pairs);
      await tx.launchImports.setColumns(id, { title: plan.title ?? null, dedupeKey: plan.dedupeKey ?? null });
      await tx.launchImports.record({
        batch,
        launchId: id,
        action: 'import',
        before: { ...before },
        summary: {
          at,
          head: plan.head ?? null,
          counts,
          postIds,
          covers: plan.media.filter((m) => m.shared).map((m) => m.publicPath),
          approved: plan.approval !== undefined,
          turnedOff: plan.channels?.turnedOff ?? [],
          notes: plan.notes,
        },
      });
    });
  }

  /**
   * Checks a batch against what it was read from and what it must not change: every current draft is
   * the file at the commit it names (by git blob hash), every file in the store has the bytes main
   * has, no channel that never published is on, the posts, comments, metrics and attempts are as many
   * as before, the deleted launches are gone, and publishing, run dry on the rows as imported, with
   * every failure and cancellation forgotten, would send nothing.
   */
  async verify(batch: string): Promise<Verification> {
    const { registry } = this.#deps;
    const out: Verification = { batch, passed: [], problems: [] };
    const rows = await registry.launchImports.batch(batch);
    if (rows.length === 0) {
      out.problems.push(`no batch ${batch} in force`);
      return out;
    }
    const at = rows.map((r) => r.summary.at).find((a): a is string => typeof a === 'string');
    const brand = at ? await this.#brand(at) : undefined;
    for (const row of rows) {
      const tag = `launch ${row.launchId}`;
      const launch = await registry.launches.get(row.launchId);
      if (row.action === 'delete') {
        if (launch) out.problems.push(`${tag}: still there after its deletion`);
        else out.passed.push(`${tag}: deleted, its ${Object.values((row.before as unknown as CapturedLaunch).rows).reduce((n, r) => n + r.length, 0)} rows kept in the batch log`);
        continue;
      }
      if (!launch) {
        out.problems.push(`${tag}: gone`);
        continue;
      }
      const summary = row.summary as { at: string; counts: LaunchCounts; covers: string[]; approved: boolean };
      const problems: string[] = [];
      const ok: string[] = [];

      const drafts = await registry.launchStore.drafts(launch.id);
      let same = 0;
      for (const draft of drafts) {
        const fields = draft.fields as Partial<VersionPlan['fields']>;
        const entry = fields.commit && fields.path ? (await this.#tree(fields.commit)).get(fields.path) : undefined;
        if (!entry) problems.push(`${fields.path ?? `${draft.channel} ${draft.piece}`}: not at ${fields.commit ?? 'any commit'}`);
        else if (gitBlobSha(draft.body) !== entry.sha) problems.push(`${fields.path}: version ${draft.n} is not the file at ${fields.commit!.slice(0, 7)}`);
        else same += 1;
        if (summary.approved && fields.from === 'pull request') problems.push(`${fields.path}: the current version is the pull request's, not main's`);
      }
      if (same === drafts.length) ok.push(`${drafts.length} drafts are the files they were read from`);

      const files = await registry.launchStore.media(launch.id, summary.covers);
      const main = await this.#tree(summary.at);
      let good = 0;
      for (const file of files) {
        const object = await this.#deps.media.get(file.path).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
        if (!object || object instanceof Error) problems.push(`${file.publicPath}: not in the media store${object instanceof Error ? ` (${object.message})` : ''}`);
        else if (sha256Hex(object.body) !== file.sha256) problems.push(`${file.publicPath}: the store's bytes are not the row's`);
        else if (file.publicPath && main.get(`public${file.publicPath}`)?.sha !== gitBlobSha(object.body)) problems.push(`${file.publicPath}: the store's bytes are not main's`);
        else good += 1;
      }
      if (good === files.length) ok.push(`${files.length} files in the store are main's`);

      const pieces = await registry.posts.posts(launch.id);
      const published = new Set<string>(pieces.map((p) => p.channel));
      const channels = (await registry.launchStore.channels(launch.id)).rows;
      const onUnpublished = channels.filter((c) => c.mode !== 'off' && !published.has(c.channel)).map((c) => c.channel);
      const draftedOn = [...new Set(drafts.map((d) => d.channel))].filter((c) => c !== RELEASE_NOTES && !published.has(c) && channels.find((r) => r.channel === c)?.mode !== 'off');
      if (onUnpublished.length > 0) problems.push(`on but never published: ${onUnpublished.join(', ')}`);
      if (draftedOn.length > 0) problems.push(`drafted, never published and not off: ${draftedOn.join(', ')}`);
      if (onUnpublished.length === 0 && draftedOn.length === 0) ok.push(`${channels.filter((c) => c.mode !== 'off').length} channels on, all published; ${channels.filter((c) => c.mode === 'off').length} off`);

      if (summary.approved && !(await registry.launchStore.approval(launch.id))) problems.push('merged, but no approval row');
      else if (summary.approved) ok.push('the merge is its approval');

      const counts = await registry.launchImports.counts(launch.id);
      if (!isDeepStrictEqual(counts, summary.counts)) problems.push(`rows changed since the import: ${JSON.stringify(summary.counts)} then, ${JSON.stringify(counts)} now`);
      else ok.push(`${counts.posts} posts, ${counts.comments} comments, ${counts.metrics} metrics, ${counts.metricDays} metric days and ${counts.publishAttempts} attempts untouched`);

      if (brand && summary.approved) {
        const dry = await this.#publishDry(launch, brand);
        if (dry.would.length > 0) problems.push(...dry.would.map((d) => `publishing would: ${d}`));
        else ok.push(`publishing, run dry with every failure forgotten, sends nothing${dry.dropped.length > 0 ? ` (its pack read without ${dry.dropped.join(', ')}, which today's schema refuses, as publishing itself would refuse the whole pack)` : ''}`);
      }
      out.passed.push(...ok.map((line) => `${tag}: ${line}`));
      out.problems.push(...problems.map((line) => `${tag}: ${line}`));
    }
    return out;
  }

  async #brand(at: string): Promise<Brand | undefined> {
    const entry = (await this.#tree(at)).get('brand.yml');
    const parsed = entry ? parseBrand(text(await this.#blob(entry.sha))) : undefined;
    return parsed?.ok ? parsed.value : undefined;
  }

  /**
   * Today's publishing run on the launch as imported, in a transaction that is always undone: its
   * pack, drafts and channels from the rows, the article live, dry publishers. Its failure and
   * cancellation cursors are forgotten first, so a later retry is covered too. Answers what it would
   * have sent or tried; nothing when the launch is done. A pack written before a channel was retired
   * is read without it (`dropped`): today's publishing refuses such a pack whole and sends nothing,
   * which would prove nothing about the channel rows.
   */
  async #publishDry(launch: Launch, brand: Brand): Promise<{ would: string[]; dropped: string[] }> {
    const { registry } = this.#deps;
    const store = registry.launchStore;
    const [stored, drafts, channels, approval] = await Promise.all([store.currentPack(launch.id), store.drafts(launch.id), store.channels(launch.id), store.approval(launch.id)]);
    if (!stored || channels.source === null) return { would: ['nothing: the launch has no pack or no channels in the rows'], dropped: [] };
    const { pack, dropped } = readPack(stored.pack);
    const dir = launchDir(launch);
    const files = new Map(drafts.flatMap((d) => (typeof d.fields.path === 'string' ? [[d.fields.path, d.body] as const] : [])));
    const yml = channelsAsLaunchYml(channels.source, channels.rows);
    const github: GitHubSource = {
      userEvents: async () => ({ notModified: true }),
      latestRelease: async () => undefined,
      pullRequestState: async () => (approval ? 'merged' : 'open'),
      fileAt: async (repo, path) => {
        if (repo === launch.repo && path === '.github/launch.yml') return yml;
        if (repo !== this.#repo) return undefined;
        if (path === `${dir}/pack.json`) return JSON.stringify(pack);
        if (path === `${dir}/launch.yml`) return yml;
        return files.get(path);
      },
    };
    const dry = this.#deps.dryPublishing();
    const fetched: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'HEAD') return new Response(null, { status: 200 });
      fetched.push(`fetch ${String(input)}`);
      return new Response(null, { status: 404 });
    }) as typeof globalThis.fetch;
    let result: PublishResult | undefined;
    try {
      await this.#deps.inTransaction(async (tx) => {
        for (const channel of CHANNELS as readonly Channel[]) {
          await tx.cursors.deleteCursor(failureKey(launch.id, channel));
          await tx.cursors.deleteCursor(cancelledKey(launch.id, channel));
        }
        throw new DryRun(await publishLaunch(launch, brand, { github, registry: tx, launchesRepo: this.#repo, publishers: dry.publishers, strategies: dry.strategies, fetch }));
      });
    } catch (error) {
      if (!(error instanceof DryRun)) return { would: [`fail: ${error instanceof Error ? error.message : String(error)}`], dropped };
      result = error.result;
    }
    const out = [...dry.calls, ...fetched];
    if (result!.state === 'waiting') out.push(`wait: ${result!.reason}`);
    if (result!.state === 'partial' || result!.state === 'published') {
      out.push(...result!.posted.map((p) => `post on ${p.channel}`), ...result!.failures.map((f) => `try ${f.channel}: ${f.message}`), ...result!.heldElsewhere.map((h) => `hold ${h.channel}: ${h.why}`));
      if (result!.state === 'partial') out.push(`leave it partial: ${result!.scheduled.map((s) => `${s.channel} scheduled`).join(', ') || 'channels pending'}`);
    }
    return { would: [...new Set(out)], dropped };
  }

  /**
   * Undoes a batch: the rows it wrote go, the launches' columns are put back, the deleted launches
   * return with every row they had. Refused while a launch of the batch has rows the batch did not
   * write (an edit made since), which a rollback would lose. The files stay in the media store: they
   * are addressed by content, and another row may name the same bytes.
   */
  async rollback(batch: string): Promise<Record<string, number>> {
    if (!this.#deps.writable) throw new ImportRefused('the launch-import flag is off (SHIPCAST_FLAGS): nothing is rolled back');
    const { registry } = this.#deps;
    const rows = await registry.launchImports.batch(batch);
    if (rows.length === 0) throw new ImportRefused(`no batch ${batch} in force`);
    const imported = rows.filter((r) => r.action === 'import');
    const foreign = await registry.launchImports.foreignRows(batch, imported.map((r) => r.launchId));
    if (foreign.length > 0) throw new ImportRefused(`the batch's launches changed since the import (${foreign.join(', ')}): roll back by hand or restore the dump`);
    return this.#deps.inTransaction(async (tx) => {
      const removed = await tx.launchImports.removeBatch(batch);
      for (const row of imported) {
        await tx.launchImports.clearPostVersions((row.summary.postIds as number[] | undefined) ?? []);
        await tx.launchImports.setColumns(row.launchId, row.before as unknown as ImportedColumns);
      }
      const deleted = rows.filter((r) => r.action === 'delete');
      for (const row of deleted) await tx.launchImports.restore(row.launchId, row.before as unknown as CapturedLaunch);
      await tx.launchImports.markRolledBack(batch);
      return { ...removed, restored: deleted.length };
    });
  }
}

function empty(launch: Launch): LaunchPlan {
  return { launch, action: 'skip', packs: [], drafts: [], media: [], posts: [], notes: [] };
}

function skipped(launch: Launch, reason: string): LaunchPlan {
  return { ...empty(launch), action: 'skip', reason };
}

/** The plan as the dry run prints it: one block per launch */
export function describePlan(plan: ImportPlan): string[] {
  const lines = [`The launches repo's main at ${plan.at}`];
  for (const l of plan.launches) {
    const name = l.launch.repo ? `${l.launch.repo} ${l.launch.ref}` : '';
    lines.push('', `Launch ${l.launch.id} ${name} (${l.launch.status ?? 'gone'}): ${l.action}${l.reason ? ` — ${l.reason}` : ''}`);
    if (l.action !== 'import') continue;
    const versions = l.drafts.reduce((n, d) => n + d.versions.length, 0);
    lines.push(`  title "${l.title ?? ''}", dedupe key ${l.dedupeKey ?? 'none'}`);
    if (l.source) lines.push(`  source: ${l.source.kind}${l.source.repo ? ` ${l.source.repo}@${l.source.ref ?? ''} ${l.source.sha ?? ''}` : ''}${l.source.text ? ` (${l.source.text.length} characters, ${String(l.source.meta?.from ?? '')})` : ''}`);
    lines.push(`  packs: ${l.packs.map((p) => p.from).join(', ') || 'none'}`);
    lines.push(`  drafts: ${l.drafts.length}, versions: ${versions} (${l.drafts.filter((d) => d.versions.length > 1).map((d) => `${d.channel} ${d.piece}`).join(', ') || 'none'} changed on main after the merge)`);
    lines.push(`  media: ${l.media.length} files, ${(l.media.reduce((n, m) => n + m.bytes.byteLength, 0) / 1048576).toFixed(2)} MiB${l.media.some((m) => m.shared) ? ` (covers: ${l.media.filter((m) => m.shared).map((m) => m.publicPath).join(', ')})` : ''}`);
    if (l.channels) {
      const on = l.channels.rows.filter((r) => r.mode !== 'off').map((r) => `${r.channel}=${r.mode}`);
      lines.push(`  channels on: ${on.join(', ') || 'none'}`, `  turned off (never published): ${l.channels.turnedOff.join(', ') || 'none'}`);
    }
    lines.push(`  approval: ${l.approval ? `${l.approval.by} at ${l.approval.at ?? '—'}` : 'none'}`);
    lines.push(`  posts linked to their draft: ${l.posts.filter((p) => p.piece !== undefined).length}/${l.posts.length}`);
    for (const note of l.notes) lines.push(`  note: ${note}`);
  }
  return lines;
}
