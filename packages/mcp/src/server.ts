import { McpServer, ResourceTemplate, type CallToolResult } from '@modelcontextprotocol/server';
import { languageName } from '@shipcast/schema';
import { z } from 'zod';
import type { ShipcastApi } from './client.ts';
import { describeError, invoke } from './errors.ts';
import { TOOL_GUIDES, TOOLS } from './tools/index.ts';

/*
 * The MCP server: Shipcast's tools, two resources and three prompts over one API client. The client is
 * the only thing that differs between stdio (a bearer token, the app's URL) and the app's /mcp (the
 * caller's own token, served in-process), so both expose exactly the same surface.
 */

export const SERVER_INFO = { name: 'shipcast', version: '1.0.0' };

const INTRO = `Shipcast launches GitHub projects and the owner's articles: it writes a content pack for every channel (blog, dev.to, Bluesky, Mastodon...) as drafts it holds for the owner to review, publishes them once the owner approves, then reads each post's numbers and comments. list_attention says what needs the user now.
Read-only tools only look. Ask the user before anything that publishes, changes or deletes something public; the tools that do it at once take confirm: true and do nothing without it. A tool that starts work answers a job: follow it with list_jobs until it ends.`;

/** The intro, then each area's guide (src/tools/<area>.ts), so an area describes its tools without editing this file */
export const INSTRUCTIONS = [INTRO, ...TOOL_GUIDES].join('\n');

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function createShipcastServer(api: ShipcastApi): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: { title: tool.title, ...tool.hints } },
      async (args: unknown): Promise<CallToolResult> => {
        const outcome = await invoke(tool, api, args);
        return outcome.ok ? { content: [{ type: 'text', text: json(outcome.value) }] } : { isError: true, content: [{ type: 'text', text: outcome.message }] };
      },
    );
  }

  const read = async <T>(path: string): Promise<T> => {
    try {
      return await api.call<T>('GET', path);
    } catch (error) {
      throw new Error(describeError(error));
    }
  };

  server.registerResource('launches', 'shipcast://launches', { title: 'Launches', description: 'The 20 latest launches and where they stand', mimeType: 'application/json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: json(await read('/launches')) }],
  }));

  server.registerResource(
    'launch',
    new ResourceTemplate('shipcast://launches/{id}', {
      list: async () => {
        const page = await read<{ launches: Array<{ id: number; repo: string; ref: string; status: string }> }>('/launches');
        return { resources: page.launches.map((l) => ({ uri: `shipcast://launches/${l.id}`, name: `${l.repo} ${l.ref}`, description: l.status, mimeType: 'application/json' })) };
      },
    }),
    { title: 'A launch', description: 'One launch with its posts, numbers, index status and drafts', mimeType: 'application/json' },
    async (uri, variables) => {
      const id = String(variables.id ?? '');
      if (!/^\d{1,10}$/.test(id)) throw new Error(`${uri.href} is not a launch: the id is a number`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: json(await read(`/launches/${id}`)) }] };
    },
  );

  server.registerPrompt(
    'launch_checklist',
    {
      title: 'Launch checklist',
      description: 'Walk through launching a repo\'s release with Shipcast, from the checks to the published posts',
      argsSchema: z.object({ repo: z.string().describe('owner/name'), ref: z.string().optional().describe('The release tag; the latest when left out') }),
    },
    ({ repo, ref }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Help me launch ${repo}${ref ? ` ${ref}` : ' (its latest release)'} with Shipcast, one step at a time:
1. Call list_releases for ${repo} and check this release was not launched already (its launch); a release is launched only once. Call check_repo and tell me what its pre-flight would refuse.
2. Call list_accounts and tell me which networks are connected and whether any account failed its last check.
3. Ask me to confirm, then call launch_repo with repo "${repo}"${ref ? ` and ref "${ref}"` : ''} (without direct, so the drafts wait for my review).
4. Follow the job with list_jobs until it ends; if the pre-flight failed, tell me which checks to fix.
5. Call get_launch and summarise its drafts; read the ones I ask about with get_draft and change them with edit_draft when I say so.
6. Only when I say the drafts are good, call approve_drafts with the versions get_launch gave and confirm: true, then follow the job and report each channel's post URL and any failure.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'launch_report',
    {
      title: 'Launch report',
      description: 'How a launch did on each channel against the period before it, from its posts, numbers, ranking and search index',
      argsSchema: z.object({ launch_id: z.string().regex(/^\d{1,10}$/, 'a launch id').optional().describe('The launch id; the latest published launch when left out') }),
    },
    ({ launch_id }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Report how ${launch_id ? `launch ${launch_id}` : 'my latest published launch'} did, channel by channel. Only read; change nothing.
1. ${launch_id ? `Call get_launch with launch_id ${launch_id}.` : 'Call list_launches with status "published" and limit 1, then get_launch with its id.'} Note its repo and ref (or title), its posts per channel with their publishedAt and url, and its failures.
2. The period runs from the day of its first publishedAt to today, as YYYY-MM-DD.
3. Call get_stats_overview with that period and launch_ids [its id]: what its own posts gathered, per channel.
4. Call get_stats_overview with the same period, no launch_ids and compare "previous": how each channel did overall against the period of the same length before.
5. Call get_stats_ranking with by "post", the same period and launch_ids [its id]: its posts from best to worst (a score of 1 is the network's typical piece).
6. Call get_search_index_status with the same period and launch_ids [its id]: whether Google and Bing indexed its articles, and their impressions and clicks.
Then summarise: a table with one row per channel (its posts, the launch's views, reactions, comments, shares and clicks, its best post's score, and the channel's change against the previous period), the articles' indexing, the failures, and two or three lines on what worked and what did not. Where a number is missing or not read yet, say so instead of guessing.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'announce_release',
    {
      title: 'Announce a release',
      description: 'Write a hand-made article announcing a release and publish it through Shipcast\'s drafts',
      argsSchema: z.object({
        repo: z.string().describe('owner/name'),
        ref: z.string().optional().describe('The release tag'),
        lang: z.string().regex(/^[a-z]{2}$/, 'an ISO 639-1 code: two lowercase letters').optional().describe('The article\'s language, one of the blog\'s (brand.yml\'s languages.blog); its primary language by default'),
      }),
    },
    ({ repo, ref, lang }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Write an article announcing ${repo}${ref ? ` ${ref}` : ''} in ${lang ? languageName(lang) : 'the blog’s primary language (the first of brand.yml’s languages.blog)'}.
- Tell only what the release really ships: read the repo's code and release notes, and keep anything planned or only documented clearly apart from what is implemented.
- Open with a paragraph that answers what the project is and what changed; use questions as section headings; no top-level heading (the title is separate).
- Show me the title and the Markdown and wait for my changes.
- When I approve it, call write_article with lang ${lang ? `"${lang}"` : 'set to that language’s code'} and the channels I name (without direct, so its drafts wait for my review), then follow the job with list_jobs and summarise the drafts from get_launch.`,
          },
        },
      ],
    }),
  );

  return server;
}
