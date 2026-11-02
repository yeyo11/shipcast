import { z } from 'zod';
import { accepted, accountId, confirm, HINTS, requireConfirm, tool, ToolRefused, type ShipcastTool } from './shared.ts';

/* Account profiles: what each network lets Shipcast change, the review of a profile, and editing it on its network */

export const guide =
  'Profiles: list_profile_capabilities says what each network lets Shipcast read and edit; review_profile starts an AI review that changes nothing, get_profile_review reads its proposals, apply_profile_proposal applies one of them on the network (edit_profile sets any field), and apply_brand_picture sets the brand\'s avatar as the picture.';

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
      'One account\'s profile capability, narrowed by its credential (`edit: reconnect` means the network could edit it but the account must be connected again), and its latest AI review: a summary, the profile as it was read and a proposal per field with the current text, the proposed one, why, any problem with it (such as a limit) and when it was applied. The review is null until review_profile has run. apply_profile_proposal applies a proposal; apply_brand_picture sets the brand\'s avatar where `brandPicture` is true.',
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
      return accepted(answer, `Reviewing the profile of account ${args.account_id}; nothing changes on its network`, 'get_profile_review');
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
  tool({
    name: 'apply_profile_proposal',
    title: 'Apply a profile proposal',
    description:
      'Apply one field of an account\'s latest profile review on its network: read the proposals with get_profile_review first, then send the field and its `proposed` text, or the user\'s change to it (links one per line as `Label: value`, the whole list). The change is public at once and replaces what was there; the review marks the proposal applied when the text is the proposed one. A proposal with a `problem` (over a limit) is refused until the text is fixed. Show the user the text and ask first, then call with `confirm: true`; without it nothing is changed.',
    operations: ['applyProfileProposal'],
    input: z.object({
      account_id: accountId,
      field: z.enum(['displayName', 'bio', 'links']).describe('The proposal\'s `field`; a picture is set with apply_brand_picture'),
      value: z.string().max(5000).describe('The text to set: the proposal\'s `proposed`, or the user\'s change to it'),
      confirm,
    }),
    hints: HINTS.destructive,
    run: (api, args) => {
      requireConfirm(args.confirm, 'apply_profile_proposal', `Changing the ${args.field} of account ${args.account_id}'s public profile`);
      return api.call('POST', `/accounts/${args.account_id}/profile-review/apply`, { body: { field: args.field, value: args.value } });
    },
  }),
  tool({
    name: 'apply_brand_picture',
    title: 'Apply the brand picture',
    description:
      'Set the brand\'s own avatar (brand.yml\'s `avatar`) as an account\'s profile picture on its network, where its credential can (`brandPicture` in get_profile_review\'s capability: a Telegram channel, a Discord webhook). Call get_profile_review first to check it can; the picture is only ever the brand\'s, never an address of the caller\'s. The change is public at once and replaces the picture there. Ask the user first, then call with `confirm: true`; without it nothing is changed.',
    operations: ['applyBrandPicture'],
    input: z.object({ account_id: accountId, confirm }),
    hints: HINTS.destructive,
    run: (api, args) => {
      requireConfirm(args.confirm, 'apply_brand_picture', `Changing the public picture of account ${args.account_id}`);
      return api.call('POST', `/accounts/${args.account_id}/profile/picture`);
    },
  }),
];
