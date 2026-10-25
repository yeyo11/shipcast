import { McpServer, ResourceTemplate, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ShipcastApi } from './client.ts';
import { describeError, invoke } from './errors.ts';
import { TOOLS } from './tools.ts';

/*
 * The MCP server: Shipcast's tools, two resources and two prompts over one API client. The client is
 * the only thing that differs between stdio (a bearer token, the app's URL) and the app's /mcp (the
 * caller's own token, served in-process), so both expose exactly the same surface.
 */

export const SERVER_INFO = { name: 'shipcast', version: '1.0.0' };

const INSTRUCTIONS = `Shipcast launches GitHub projects: on a release it analyses the repo, writes a content pack for every channel (blog, dev.to, Bluesky, Mastodon...) into a drafts pull request, and publishes it once the owner approves.
Read with list_launches, get_launch, list_jobs, list_accounts and get_capabilities. launch_repo, approve_drafts, write_article and retry_channel start background work that publishes publicly: confirm with the user first, then follow the job with list_jobs. edit_post changes a live post; delete_post removes one for good and needs confirm: true after the user agrees.`;

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
1. Call list_launches and check this release was not launched already; a release is launched only once.
2. Call list_accounts and tell me which networks are connected and whether any account failed its last check.
3. Ask me to confirm, then call launch_repo with repo "${repo}"${ref ? ` and ref "${ref}"` : ''} (without direct, so the drafts go to a pull request).
4. Follow the job with list_jobs until it ends; if the pre-flight failed, tell me which checks to fix.
5. Call get_launch and summarise the drafts pull request and its files, with its link, so I can review them on GitHub.
6. Only when I say the drafts are good, call approve_drafts, then follow the job and report each channel's post URL and any failure.`,
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
        lang: z.enum(['en', 'es']).optional().describe('The article\'s language; English by default'),
      }),
    },
    ({ repo, ref, lang }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Write an article announcing ${repo}${ref ? ` ${ref}` : ''} in ${lang === 'es' ? 'Spanish' : 'English'}.
- Tell only what the release really ships: read the repo's code and release notes, and keep anything planned or only documented clearly apart from what is implemented.
- Open with a paragraph that answers what the project is and what changed; use questions as section headings; no top-level heading (the title is separate).
- Show me the title and the Markdown and wait for my changes.
- When I approve it, call write_article with lang "${lang ?? 'en'}" and the channels I name (without direct, so it goes to a drafts pull request), then follow the job with list_jobs and give me the pull request's link from get_launch.`,
          },
        },
      ],
    }),
  );

  return server;
}
