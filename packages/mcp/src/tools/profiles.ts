import { z } from 'zod';
import { accepted, accountId, confirm, HINTS, requireConfirm, tool, ToolRefused, type ShipcastTool } from './shared.ts';

/* Account profiles: what each network lets Shipcast change, the review of a profile, and editing it on its network */

export const guide =
  'Profiles: list_profile_capabilities says what each network lets Shipcast read and edit on an account\'s profile, and get_profile_review reads an account\'s latest AI review with its proposals. review_profile starts a background review that changes nothing on the network; edit_profile changes the public profile and needs confirm: true after the user agrees.';

// The API's own limits (profileEditInput and reviewInput of apps/web), which the network's own may narrow further
const displayName = z.string().max(500);
const bio = z.string().max(5000);

export const tools: ShipcastTool[] = [
  tool({
    name: 'list_profile_capabilities',
    title: 'List profile capabilities',
    description:
      'What each network lets Shipcast do with an account\'s profile: whether it reads the profile itself or the owner pastes it, whether it can edit it and which fields (display name, bio, links), and the network\'s length limits. Check this before review_profile or edit_profile; get_profile_review gives one account\'s, narrowed by its credential.',
    operations: ['listProfileCapabilities'],
    input: z.object({}),
    hints: HINTS.read,
    run: (api) => api.call('GET', '/profile-capabilities'),
  }),
  tool({
    name: 'get_profile_review',
    title: 'Get a profile review',
    description:
      'One account\'s profile capability, narrowed by its credential (`edit: reconnect` means the network could edit it but the account must be connected again), and its latest AI review: a summary, the profile as it was read and a proposal per field with the current text, the proposed one, why, any problem with it (such as a limit) and when it was applied. The review is null until review_profile has run.',
    operations: ['getProfileReview'],
    input: z.object({ account_id: accountId }),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', `/accounts/${args.account_id}/profile-review`),
  }),
  tool({
    name: 'review_profile',
    title: 'Review a profile',
    description:
      'Start an AI review of an account\'s profile as a background job (about a minute, one AI run): it reads the profile, the account\'s growth and the brand, and proposes new text for each field. Nothing changes on the network; the new review replaces the account\'s previous one, and get_profile_review reads it once the job ends. Where the network cannot read the profile (LinkedIn, Reddit) or leaves fields out (Instagram\'s and Threads\' links), pass what the profile says in `pasted`.',
    operations: ['reviewProfile'],
    input: z.object({
      account_id: accountId,
      pasted: z
        .object({
          display_name: displayName.optional().describe('The name the profile shows'),
          bio: bio.optional().describe('The bio or About text, as it is'),
          links: z.string().max(5000).optional().describe('The links, one per line as `Label: value`'),
        })
        .optional()
        .describe('The profile as it is now, copied by the user, for what Shipcast cannot read; a pasted field replaces the one read'),
      language: z
        .string()
        .regex(/^[a-z]{2}$/, 'an ISO 639-1 code, such as en or es')
        .optional()
        .describe('The language to write the proposals in, one of the brand\'s, such as en or es; the brand\'s first when left out'),
    }),
    hints: HINTS.work,
    run: async (api, args) => {
      const pasted = args.pasted && {
        ...(args.pasted.display_name !== undefined && { displayName: args.pasted.display_name }),
        ...(args.pasted.bio !== undefined && { bio: args.pasted.bio }),
        ...(args.pasted.links !== undefined && { links: args.pasted.links }),
      };
      const body = { ...(pasted && { pasted }), ...(args.language !== undefined && { language: args.language }) };
      // The route takes no body at all for a plain review
      const answer = await api.call('POST', `/accounts/${args.account_id}/profile-review`, Object.keys(body).length > 0 ? { body } : {});
      return accepted(answer, `Reviewing the profile of account ${args.account_id}; nothing changes on its network, and get_profile_review reads the proposals once the job ends`);
    },
  }),
  tool({
    name: 'edit_profile',
    title: 'Edit a profile',
    description:
      'Change an account\'s public profile on its network (Mastodon, Bluesky, a Telegram channel, a Discord webhook\'s name), with the account\'s own credential: only the fields given, within the network\'s limits (see list_profile_capabilities). The change is public at once and replaces what was there. Show the user the new text and ask first, then call with `confirm: true`; without it nothing is changed.',
    operations: ['editProfile'],
    input: z.object({
      account_id: accountId,
      display_name: displayName.optional().describe('The new name the profile shows'),
      bio: bio.optional().describe('The new bio or description'),
      links: z
        .array(z.object({ name: z.string().max(500).describe('The link\'s label'), value: z.string().max(2000).describe('The address or text') }))
        .max(20)
        .optional()
        .describe('The whole list of links (Mastodon\'s fields, Bluesky\'s links): it replaces the one there, so include the links to keep'),
      confirm,
    }),
    hints: HINTS.destructive,
    run: (api, args) => {
      const edit = {
        ...(args.display_name !== undefined && { displayName: args.display_name }),
        ...(args.bio !== undefined && { bio: args.bio }),
        ...(args.links !== undefined && { links: args.links }),
      };
      if (Object.keys(edit).length === 0) throw new ToolRefused('edit_profile needs at least one field to change: display_name, bio or links');
      requireConfirm(args.confirm, 'edit_profile', `Changing the public profile of account ${args.account_id}`);
      return api.call('PATCH', `/accounts/${args.account_id}/profile`, { body: edit });
    },
  }),
];
