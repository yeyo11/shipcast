import { z } from 'zod';
import { ShipcastApiError } from '../client.ts';
import { accepted, channel, confirm, HINTS, launchId, PUBLISHES, requireConfirm, tool, ToolRefused, type ShipcastTool } from './shared.ts';

/* Launching from sources (with the media uploaded for it), changing or deleting every post of a launch at once, and deleting a launch */

export const guide =
  'Sources and whole launches: upload_media stores an image, then launch_from_sources drafts a launch from text, pages, repos and images for approve_drafts. edit_launch_posts and delete_launch_posts change every live post of a launch; plan_launch_deletion shows what delete_launch would do, before it.';

// The engine's limits (MAX_UPLOAD_BYTES, SOURCE_LIMITS), which this browser-safe package cannot import
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** The longest base64 that can decode within MAX_UPLOAD_BYTES, so an oversized image is refused before it is decoded */
const MAX_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;

/**
 * The two flags behind these routes, and how the API answers while each is off: the deletion routes
 * with a 404 that names their flag, the sources routes with a 409 refusal. Left as they come, the model
 * would read "no such launch" or "do not retry, tell the user why" without learning the feature is off.
 */
const FLAGS = {
  sources: {
    what: 'Launching from sources',
    flag: 'launch-sources',
    off: (error: ShipcastApiError) => error.status === 409 && /not available in this process/.test(error.message),
  },
  deletion: {
    what: 'Deleting launches',
    flag: 'launch-delete',
    off: (error: ShipcastApiError) => error.status === 404 && /launch-delete flag/.test(error.message),
  },
} as const;

async function unlessOff<T>(feature: keyof typeof FLAGS, call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    const { what, flag, off } = FLAGS[feature];
    if (error instanceof ShipcastApiError && off(error)) {
      throw new ToolRefused(`${what} is turned off on this Shipcast: its ${flag} feature flag is off (SHIPCAST_FLAGS). Nothing was changed. Tell the user; only the owner can turn it on, so do not retry.`);
    }
    throw error;
  }
}

/** An image the model holds as base64 (or a data: URL), as the bytes POST /media takes */
function imageBytes(data: string): Uint8Array<ArrayBuffer> {
  const base64 = data
    .replace(/^data:[^,]*;base64,/i, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  if (base64.length > MAX_BASE64_CHARS) throw new ToolRefused('Nothing was uploaded: the image is larger than the 20 MiB Shipcast takes. Ask the user for a smaller file.');
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new ToolRefused('Nothing was uploaded: image_base64 is not valid base64. Send the file\'s bytes base64-encoded, or as a data: URL.');
  }
  if (binary.length === 0) throw new ToolRefused('Nothing was uploaded: image_base64 is empty.');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const channels = (what: string) => z.array(channel).min(1).optional().describe(what);
const csv = (list: readonly string[] | undefined) => (list && list.length > 0 ? list.join(',') : undefined);

const source = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    text: z.string().min(1).max(100_000).describe('The user\'s own words: notes, a draft, an opinion. The authority on their opinions'),
    title: z.string().min(1).max(200).optional().describe('A name for this text'),
  }),
  z.object({
    kind: z.literal('url'),
    url: z.url({ protocol: /^https?$/ }).max(2000).describe('A public http(s) page, fetched once by Shipcast'),
  }),
  z.object({
    kind: z.literal('repo'),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name').describe('A GitHub repo, owner/name'),
    ref: z.string().min(1).max(140).optional().describe('For the primary repo, its release tag (its latest release when left out); for another repo, a branch or tag (its default branch when left out)'),
    primary: z.boolean().optional().describe('The repo whose release this launch is; the first repo when none is marked'),
  }),
  z.object({
    kind: z.literal('media'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'the sha256 upload_media answered').describe('The `sha256` upload_media answered for the image'),
    name: z.string().min(1).max(500).optional().describe('The file\'s name'),
    alt: z.string().min(1).max(500).optional().describe('What the image shows'),
  }),
]);

export const tools: ShipcastTool[] = [
  tool({
    name: 'launch_from_sources',
    title: 'Launch from sources',
    description:
      'Make a launch from sources and draft it: the user\'s own text, public pages, GitHub repos and images uploaded with upload_media (1 to 12 sources; at most 5 repos, 8 pages and 10 images). With a repo, the primary repo\'s release is the launch (launched only once) and its launch.yml chooses the channels; with no repo it is claimed by its title, which cannot launch twice, and goes on the blog plus the `channels` named. Shipcast writes every channel\'s content for review; approve_drafts publishes it. Only on a Shipcast with launches from sources turned on. ' +
      PUBLISHES,
    operations: ['launchFromSources'],
    input: z.object({
      title: z.string().min(1).max(200).describe('The launch\'s title'),
      lang: z.enum(['en', 'es']).optional().describe('The language of the title and the user\'s text; en by default'),
      channels: z.array(channel).optional().describe('Channels to announce it on besides the blog, for a launch with no repo; a repo\'s launch.yml decides for one with a primary repo'),
      sources: z.array(source).min(1).max(12).describe('What the launch is made from; each one\'s `kind` is text, url, repo or media'),
    }),
    hints: HINTS.work,
    run: async (api, args) => {
      const sources = args.sources.map((s) => {
        switch (s.kind) {
          case 'text':
            return { kind: s.kind, text: s.text, ...(s.title !== undefined && { title: s.title }) };
          case 'url':
            return { kind: s.kind, url: s.url };
          case 'repo':
            return { kind: s.kind, repo: s.repo, ...(s.ref !== undefined && { ref: s.ref }), ...(s.primary === true && { primary: true }) };
          case 'media':
            return { kind: s.kind, sha256: s.sha256, ...(s.name !== undefined && { name: s.name }), ...(s.alt !== undefined && { alt: s.alt }) };
        }
      });
      const body = { title: args.title, lang: args.lang ?? 'en', channels: args.channels ?? [], sources };
      return accepted(await unlessOff('sources', api.call('POST', '/launches/sources', { body })), `Launching "${args.title}" from ${sources.length} source${sources.length === 1 ? '' : 's'}`);
    },
  }),
  tool({
    name: 'upload_media',
    title: 'Upload an image',
    description:
      'Upload an image for launch_from_sources: PNG, JPEG, GIF or WebP, up to 20 MiB, given as base64. Shipcast removes its metadata (EXIF, GPS) and answers the stored file; name it in launch_from_sources as a source { kind: "media", sha256 } with that sha256. Uploading publishes nothing. Only on a Shipcast with launches from sources turned on.',
    operations: ['uploadMedia'],
    input: z.object({
      image_base64: z.string().min(1).describe('The image file\'s bytes, base64-encoded; a data: URL is taken too'),
    }),
    // Stays inside Shipcast, and the same bytes are stored once under their sha256
    hints: HINTS.setting,
    run: async (api, args) => {
      const bytes = imageBytes(args.image_base64);
      const answer = await unlessOff('sources', api.call<{ file: { sha256: string } }>('POST', '/media', { raw: { bytes, contentType: 'application/octet-stream' } }));
      return { ...answer, note: `Name this image in launch_from_sources as { kind: "media", sha256: "${answer.file.sha256}" }, with a name and alt text.` };
    },
  }),
  tool({
    name: 'edit_launch_posts',
    title: 'Edit every post of a launch',
    description:
      'Edit every live post of a launch at once, on each network, with the same fields; each network takes the fields it has (get_capabilities) and the answer reports each post\'s outcome. Only posts already out are changed: pieces still scheduled are left out (reschedule or cancel them instead), and so are deleted ones. The change is public at once and replaces what was there: show the user the new text, then call with `confirm: true`; without it nothing changes. Use edit_post for one post.',
    operations: ['editLaunchPosts'],
    input: z.object({
      launch_id: launchId,
      channels: channels('Only the posts on these channels; every channel when left out'),
      text: z.string().min(1).optional().describe('The new text; on dev.to, Hashnode and the blog, the article\'s Markdown body'),
      title: z.string().min(1).max(200).optional().describe('Articles only: dev.to, Hashnode and the blog'),
      tags: z.array(z.string()).max(10).optional().describe('Articles only'),
      link: z.url().optional().describe('Added after the text on Mastodon, Telegram and Discord; the canonical URL on dev.to and Hashnode'),
      image_url: z.url().optional().describe('A new image: Mastodon, Telegram, and dev.to and Hashnode covers'),
      image_alt: z.string().optional().describe('What the image shows, where the network keeps it'),
      confirm,
    }),
    hints: HINTS.destructive,
    run: (api, args) => {
      const changes = {
        ...(args.text !== undefined && { text: args.text }),
        ...(args.title !== undefined && { title: args.title }),
        ...(args.tags !== undefined && { tags: args.tags }),
        ...(args.link !== undefined && { link: args.link }),
        ...(args.image_url !== undefined && { imageUrl: args.image_url }),
        ...(args.image_alt !== undefined && { imageAlt: args.image_alt }),
      };
      if (Object.keys(changes).length === 0) throw new ToolRefused('edit_launch_posts needs at least one field to change: text, title, tags, link, image_url or image_alt');
      requireConfirm(args.confirm, 'edit_launch_posts', `Changing ${args.channels ? `the ${args.channels.join(', ')} posts` : 'every live post'} of launch ${args.launch_id} in public`);
      return api.call('PATCH', `/launches/${args.launch_id}/posts`, { body: { ...changes, ...(args.channels && { channels: args.channels }) } });
    },
  }),
  tool({
    name: 'delete_launch_posts',
    title: 'Delete every post of a launch',
    description:
      'Delete every live post of a launch from its network, or only those on the channels named (dev.to only unpublishes; Instagram and the newsletter cannot delete, which is reported). Pieces still scheduled are left out. It cannot be undone and the launch never publishes them again; the launch itself stays. Ask the user first, then call with `confirm: true`; without it nothing is deleted.',
    operations: ['deleteLaunchPosts'],
    input: z.object({ launch_id: launchId, channels: channels('Only the posts on these channels; every channel when left out'), confirm }),
    hints: HINTS.destructive,
    run: (api, args) => {
      requireConfirm(args.confirm, 'delete_launch_posts', `Deleting ${args.channels ? `the ${args.channels.join(', ')} posts` : 'every post'} of launch ${args.launch_id}`);
      return api.call('DELETE', `/launches/${args.launch_id}/posts`, { query: { channels: csv(args.channels) } });
    },
  }),
  tool({
    name: 'plan_launch_deletion',
    title: 'Plan a launch\'s deletion',
    description:
      'Call this before delete_launch: says what deleting a launch would do, changing nothing. `mode` is removed (nothing of it was ever out: it goes entirely) or hidden (it published: it leaves the lists and its posts stay on the networks unless their channels are named); `refused` says why it cannot be deleted now; `channels` lists each channel with posts out, how many, and whether deleting there removes, only unpublishes or cannot touch them; `articleLinks` counts the posts linking its article. Show this to the user before delete_launch.',
    operations: ['planLaunchDeletion'],
    input: z.object({ launch_id: launchId }),
    hints: HINTS.read,
    run: (api, args) => unlessOff('deletion', api.call('GET', `/launches/${args.launch_id}/deletion`)),
  }),
  tool({
    name: 'delete_launch',
    title: 'Delete a launch',
    description:
      'Delete a launch. First call plan_launch_deletion and show the user what it would do. One never published is removed with everything it has (its drafts pull request is closed); a published one is hidden: it leaves the lists, nothing more of it goes out, and its release is never launched again. Its posts stay on the networks except on the `channels` named, whose posts are deleted there too (naming blog removes the article, even while other posts link it). It cannot be undone: call with `confirm: true` only after the user agrees; without it nothing is deleted.',
    operations: ['deleteLaunch'],
    input: z.object({
      launch_id: launchId,
      channels: channels('Channels whose posts are deleted from the networks too; none when left out'),
      confirm,
    }),
    hints: HINTS.destructive,
    run: (api, args) => {
      requireConfirm(args.confirm, 'delete_launch', `Deleting launch ${args.launch_id}`);
      return unlessOff('deletion', api.call('DELETE', `/launches/${args.launch_id}`, { query: { channels: csv(args.channels) } }));
    },
  }),
];
