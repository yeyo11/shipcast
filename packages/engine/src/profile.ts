import type { Profile, ProfileEdit, ProfileLink } from '@shipcast/connectors';
import { AI_TASK_DEFINITIONS, graphemeCount, PROFILE_CAPABILITIES, Refused, type Brand, type EditableField, type ProfileCapability, ProfileReviewAnswer } from '@shipcast/schema';
import { z } from 'zod';
import type { AiTaskRunner } from './ai/runner.ts';
import { isArticle } from './drafts.ts';
import { buildProfileReviewPrompt, type PromptOptions, type ProfileFieldId, type ProfileLimits, type ProfileReviewInput } from './prompt.ts';
import type { Account, Repositories } from './repositories/index.ts';
import { accountGrowth } from './stats.ts';

/*
 * Account analysis: an AI review of an account's own profile, with proposals per field, and the
 * edits where the network's API allows them (Mastodon, Bluesky, a Telegram channel). Elsewhere a
 * proposal is text to copy. The latest review of each account is kept in the registry's cursors, so
 * no migration. See docs/decisions/account-analysis.md
 */

export type { EditableField, ProfileCapability } from '@shipcast/schema';

/**
 * Each network's profile, as of 2026-10-27, from its channel's definition. Limits are the networks'
 * defaults; a Mastodon instance may allow more. A network not listed has no profile to review (a
 * webhook, a search console).
 */
export { PROFILE_CAPABILITIES };

/** The scope a Mastodon token needs to edit the profile; the account keeps the scopes it was granted */
const MASTODON_WRITE_ACCOUNTS = 'write:accounts';

/**
 * What can be done with this account's profile: the network's capability, narrowed by its
 * credential. A Mastodon account connected before Shipcast asked for write:accounts (no `scopes`
 * recorded) must connect again before an edit; reviews and copying still work.
 */
export function profileCapability(account: Pick<Account, 'network' | 'settings'>): ProfileCapability | undefined {
  const base = PROFILE_CAPABILITIES[account.network];
  if (!base) return undefined;
  if (account.network === 'mastodon' && !(account.settings.scopes ?? '').split(/\s+/).includes(MASTODON_WRITE_ACCOUNTS)) {
    return { ...base, edit: 'reconnect', note: 'Connect the account again to allow profile edits: its token was granted before Shipcast asked for write:accounts' };
  }
  return base;
}

/** Why a review or an edit was not made, so the API can answer 404, 409 or 400 */
export class ProfileRefused extends Refused<'not_found' | 'unsupported' | 'reconnect' | 'invalid'> {}

// Moved to packages/schema/src/ai/answers.ts with the AI task definitions; kept here for its callers
export { ProfileReviewAnswer, profileReviewJsonSchema } from '@shipcast/schema';

export interface ProfileProposal {
  field: ProfileFieldId;
  current: string;
  proposed: string;
  why: string;
  /** Why it cannot be applied as it is (over a limit, a link not written as `Label: value`) */
  problem?: string;
  /** When the owner applied it through Shipcast */
  appliedAt?: string;
}

export interface ProfileReview {
  accountId: number;
  network: string;
  reviewedAt: string;
  language: string;
  summary: string;
  /** The profile the review read */
  profile: Profile;
  proposals: ProfileProposal[];
}

const reviewKey = (accountId: number) => `profile-review:${accountId}`;

/** The account's latest review; undefined when it has none, or the one stored no longer parses */
export async function readProfileReview(registry: Pick<Repositories, 'cursors'>, accountId: number): Promise<ProfileReview | undefined> {
  const text = await registry.cursors.cursor(reviewKey(accountId));
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as ProfileReview;
    return value && value.accountId === accountId && Array.isArray(value.proposals) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A field's value as text, the way a proposal states it: links one per line as `Label: value` */
export function fieldText(profile: Profile, field: ProfileFieldId): string {
  if (field === 'displayName') return profile.displayName ?? '';
  if (field === 'bio') return profile.bio ?? '';
  if (field === 'links') return profile.links.map((l) => `${l.name}: ${l.value}`).join('\n');
  return profile.hasAvatar ? '(a picture is set)' : '';
}

/** `Label: value` lines as links; undefined when a line is not written that way */
export function parseLinks(text: string): ProfileLink[] | undefined {
  const links: ProfileLink[] = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const at = line.indexOf(': ');
    if (at <= 0) return undefined;
    links.push({ name: line.slice(0, at).trim(), value: line.slice(at + 2).trim() });
  }
  return links;
}

/** What is wrong with a value for a field on this network: over a limit, or links not as `Label: value` */
export function fieldProblem(field: ProfileFieldId, value: string, limits: ProfileLimits): string | undefined {
  const length = (text: string) => (limits.graphemes ? graphemeCount(text) : [...text].length);
  const unit = limits.graphemes ? 'graphemes' : 'characters';
  if (field === 'displayName' && limits.displayName && length(value) > limits.displayName) return `the name has ${length(value)} ${unit}; at most ${limits.displayName}`;
  if (field === 'bio' && limits.bio && length(value) > limits.bio) return `the bio has ${length(value)} ${unit}; at most ${limits.bio}`;
  if (field === 'links') {
    const links = parseLinks(value);
    if (!links) return 'write each link on its own line as `Label: value`';
    if (limits.links) {
      if (links.length > limits.links.count) return `${links.length} links; at most ${limits.links.count}`;
      const long = links.find((l) => [...l.name].length > limits.links!.name || [...l.value].length > limits.links!.value);
      if (long) return `the link “${long.name}” is longer than the network allows`;
    }
  }
  return undefined;
}

/** What a connector offers for one account's profile; `@shipcast/runtime`'s Built fits */
export interface ProfileConnector {
  profile?(): Promise<Profile>;
  editProfile?(edit: ProfileEdit): Promise<void>;
}

export interface ProfileDeps {
  registry: Pick<Repositories, 'launches' | 'accounts' | 'cursors' | 'queries'>;
  brand: Brand;
  /** The AI task runner the review runs on */
  aiRunner: AiTaskRunner;
  /** The owner's prompts and tone, read before a review; the defaults in code without */
  texts?(): Promise<PromptOptions>;
  /** The account's connector, built with its own credential; undefined when it cannot be built */
  connector(account: Account): Promise<ProfileConnector | undefined>;
  now?: () => Date;
}

async function existing(registry: Pick<Repositories, 'accounts'>, accountId: number): Promise<{ account: Account; capability: ProfileCapability }> {
  const account = await registry.accounts.account(accountId);
  if (!account) throw new ProfileRefused('not_found', 'no such account');
  const capability = profileCapability(account);
  if (!capability) throw new ProfileRefused('unsupported', `${account.network} has no profile to review`);
  return { account, capability };
}

/** The first and last count of each measure over the period, from the daily snapshots */
async function growthOf(registry: Pick<Repositories, 'launches' | 'accounts' | 'cursors' | 'queries'>, accountId: number, now: Date, days = 90): Promise<ProfileReviewInput['growth']> {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const { points } = await accountGrowth(registry, accountId, { from, to });
  const span = (key: 'followers' | 'following' | 'posts') => {
    const values = points.map((p) => p[key]).filter((v): v is number => v !== null);
    return values.length > 0 ? { first: values[0]!, last: values.at(-1)! } : undefined;
  };
  const followers = span('followers');
  const following = span('following');
  const posts = span('posts');
  if (!followers && !following && !posts) return undefined;
  return { days, ...(followers && { followers }), ...(following && { following }), ...(posts && { posts }) };
}

/** The repos the brand launched, the newest first, each once */
async function projectsOf(registry: Pick<Repositories, 'launches'>): Promise<string[]> {
  const repos = (await registry.launches.recent(100)).filter((l) => l.status === 'published' && !isArticle(l)).map((l) => l.repo);
  return [...new Set(repos)].slice(0, 10);
}

/**
 * Reviews one account's profile: reads it from the network (or takes what the owner pasted, where
 * the network cannot read it), asks the `profile` task for proposals, keeps those that are new and
 * of a field the network has, states each one's `current` from the profile itself rather than from
 * the AI, marks the ones over a limit, and keeps the review as the account's latest.
 */
export async function reviewProfile(
  deps: ProfileDeps,
  accountId: number,
  options: { pasted?: { displayName?: string; bio?: string; links?: string }; language?: string } = {},
): Promise<ProfileReview> {
  const { registry, brand } = deps;
  const now = deps.now?.() ?? new Date();
  const { account, capability } = await existing(registry, accountId);
  let profile: Profile;
  if (capability.read) {
    const connector = await deps.connector(account);
    if (!connector?.profile) throw new ProfileRefused('unsupported', `the ${account.network} account cannot be read: check it on the Channels page`);
    profile = await connector.profile();
    // What the API leaves out (Instagram's other links, Threads' links), where the owner pasted it
    const pasted = options.pasted ?? {};
    const paste = capability.paste ?? [];
    if (paste.includes('links') && pasted.links?.trim()) {
      const links = parseLinks(pasted.links);
      if (!links) throw new ProfileRefused('invalid', 'write each link on its own line as `Label: value`');
      profile = { ...profile, links };
    }
    if (paste.includes('bio') && pasted.bio?.trim()) profile = { ...profile, bio: pasted.bio.trim() };
    if (paste.includes('displayName') && pasted.displayName?.trim()) profile = { ...profile, displayName: pasted.displayName.trim() };
  } else {
    const pasted = options.pasted ?? {};
    const links = pasted.links ? parseLinks(pasted.links) : [];
    if (!links) throw new ProfileRefused('invalid', 'write each link on its own line as `Label: value`');
    if (!pasted.displayName?.trim() && !pasted.bio?.trim() && links.length === 0) {
      throw new ProfileRefused('invalid', `${account.network}’s API does not give the profile: paste at least its bio to review it`);
    }
    // What the credential can read of a profile it cannot read whole (LinkedIn's name and photo)
    // fills what the paste leaves out; a read that fails costs the review nothing
    const readable = capability.readable ?? [];
    const read =
      readable.length > 0
        ? await deps
            .connector(account)
            .then((c) => c?.profile?.())
            .catch(() => undefined)
        : undefined;
    const displayName = pasted.displayName?.trim() || (readable.includes('displayName') ? read?.displayName : undefined);
    profile = {
      ...(displayName && { displayName }),
      ...(pasted.bio?.trim() && { bio: pasted.bio.trim() }),
      links,
      hasAvatar: (readable.includes('avatar') ? read?.hasAvatar : undefined) ?? account.avatarUrl !== null,
    };
  }
  const languages = brand.languages.blog;
  const language = options.language && languages.includes(options.language as (typeof languages)[number]) ? options.language : (languages[0] ?? 'en');
  const texts: PromptOptions = (await deps.texts?.()) ?? {};
  const { prompt, system } = buildProfileReviewPrompt(
    {
      network: account.network,
      account: account.identity ?? account.label,
      profile,
      fields: capability.fields,
      limits: capability.limits,
      growth: await growthOf(registry, account.id, now),
      projects: await projectsOf(registry),
      language,
    },
    brand,
    texts,
  );
  // An AiError (and an answer still invalid after its repair) fails the review's job as it is
  const { output } = await deps.aiRunner.run(AI_TASK_DEFINITIONS.profile, { system, prompt });
  const parsed = ProfileReviewAnswer.safeParse(output);
  if (!parsed.success) throw new Error(`the AI's answer is not a review: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const proposals: ProfileProposal[] = [];
  for (const p of parsed.data.proposals) {
    if (!capability.fields.includes(p.field)) continue;
    const current = fieldText(profile, p.field);
    const proposed = p.proposed.trim();
    if (!proposed || proposed === current.trim()) continue;
    const problem = p.field === 'avatar' ? undefined : fieldProblem(p.field, proposed, capability.limits);
    proposals.push({ field: p.field, current, proposed, why: p.why.trim(), ...(problem && { problem }) });
  }
  const review: ProfileReview = { accountId: account.id, network: account.network, reviewedAt: now.toISOString(), language, summary: parsed.data.summary.trim(), profile, proposals };
  await registry.cursors.setCursor(reviewKey(account.id), JSON.stringify(review));
  return review;
}

/**
 * Changes an account's profile on its network, after checking the capability and the limits, and
 * marks the latest review's proposals that this edit applied. Only what the edit names changes.
 * Answers the profile as the network has it afterwards, where it can be read.
 */
export async function editProfile(deps: Pick<ProfileDeps, 'registry' | 'connector' | 'now'>, accountId: number, edit: ProfileEdit): Promise<Profile | undefined> {
  const { account, capability } = await existing(deps.registry, accountId);
  if (capability.edit === 'reconnect') throw new ProfileRefused('reconnect', capability.note);
  if (capability.edit === 'no') throw new ProfileRefused('unsupported', capability.note);
  const named = (Object.keys(edit) as Array<keyof ProfileEdit>).filter((k) => edit[k] !== undefined);
  if (named.length === 0) throw new ProfileRefused('invalid', 'send at least one of displayName, bio, links');
  for (const field of named) {
    if (!(capability.editable as readonly string[]).includes(field)) throw new ProfileRefused('invalid', `${account.network} cannot change the ${field} through its API`);
  }
  const values: Array<[EditableField, string]> = [];
  if (edit.displayName !== undefined) values.push(['displayName', edit.displayName]);
  if (edit.bio !== undefined) values.push(['bio', edit.bio]);
  if (edit.links !== undefined) values.push(['links', edit.links.map((l) => `${l.name}: ${l.value}`).join('\n')]);
  for (const [field, value] of values) {
    const problem = fieldProblem(field, value, capability.limits);
    if (problem) throw new ProfileRefused('invalid', problem);
  }
  const connector = await deps.connector(account);
  if (!connector?.editProfile) throw new ProfileRefused('unsupported', `the ${account.network} account cannot be edited: check it on the Channels page`);
  await connector.editProfile(edit);

  const review = await readProfileReview(deps.registry, account.id);
  if (review) {
    const at = (deps.now?.() ?? new Date()).toISOString();
    let changed = false;
    for (const proposal of review.proposals) {
      const value = values.find(([field]) => field === proposal.field)?.[1];
      if (value !== undefined && value.trim() === proposal.proposed.trim() && !proposal.appliedAt) {
        proposal.appliedAt = at;
        changed = true;
      }
    }
    if (changed) await deps.registry.cursors.setCursor(reviewKey(account.id), JSON.stringify(review));
  }
  return connector.profile ? connector.profile().catch(() => undefined) : undefined;
}

/**
 * Sets brand.yml's avatar as an account's picture, on the networks that take one through the
 * credential Shipcast holds (a Telegram channel's photo, a Discord webhook's picture). The picture is
 * only ever the brand's own: a review's proposal for it is advice, never an address to set.
 */
export async function setBrandPicture(deps: Pick<ProfileDeps, 'registry' | 'connector' | 'brand'>, accountId: number): Promise<Profile | undefined> {
  const { account, capability } = await existing(deps.registry, accountId);
  if (capability.edit === 'reconnect') throw new ProfileRefused('reconnect', capability.note);
  if (capability.edit === 'no' || !capability.brandPicture) throw new ProfileRefused('unsupported', `${account.network} cannot change the picture through its API`);
  if (!deps.brand.avatar) throw new ProfileRefused('invalid', 'brand.yml has no avatar to set: add its https address there first');
  const connector = await deps.connector(account);
  if (!connector?.editProfile) throw new ProfileRefused('unsupported', `the ${account.network} account cannot be edited: check it on the Channels page`);
  await connector.editProfile({ picture: deps.brand.avatar });
  return connector.profile ? connector.profile().catch(() => undefined) : undefined;
}

/**
 * The capability as the app shows it beside a review: a network that said, when the review read
 * the profile, that this credential may not edit it (a Telegram bot without the admin right) is
 * shown as not editable, with its reason.
 */
export function capabilityWithReview(capability: ProfileCapability, review: Pick<ProfileReview, 'profile'> | undefined): ProfileCapability {
  const editable = review?.profile.editable;
  if (capability.edit === 'yes' && editable && !editable.ok) return { ...capability, edit: 'no', note: editable.why };
  return capability;
}

/** A proposal as an edit: the field's new value, links parsed from their lines */
export function proposalEdit(proposal: Pick<ProfileProposal, 'field' | 'proposed'>): ProfileEdit {
  if (proposal.field === 'displayName') return { displayName: proposal.proposed };
  if (proposal.field === 'bio') return { bio: proposal.proposed };
  if (proposal.field === 'links') {
    const links = parseLinks(proposal.proposed);
    if (!links) throw new ProfileRefused('invalid', 'write each link on its own line as `Label: value`');
    return { links };
  }
  throw new ProfileRefused('invalid', 'a picture is changed by hand, on the network');
}
