import { CHANNELS, DEFAULT_TRIGGER_RULES, InvalidRequest, parseLaunchConfig, TriggerRule, TriggerRules, type Brand, type Channel } from '@shipcast/schema';
import { stringify } from 'yaml';
import { channelRows } from '../launch-store.ts';
import type { Launch, Repositories } from '../repositories/index.ts';

/** The setting the owner's trigger rules are kept under */
export const TRIGGERS_SETTING = 'triggers';

/**
 * The launch.yml a rule stands in for when the repo has none: every channel the rule names waits
 * for approval, every other is off. Kept as the launch's channels (`channels_source`), so the draft,
 * the review and publishing read it as they read a repo's own.
 */
export function ruleLaunchYml(brand: Pick<Brand, 'id'>, channels: readonly Channel[]): string {
  const publishing = Object.fromEntries(CHANNELS.map((c) => [c, channels.includes(c) ? 'approval' : 'off']));
  return stringify({ enabled: true, brand: brand.id, publishing });
}

export interface TriggerServiceDeps {
  registry: Pick<Repositories, 'settings' | 'launchStore'>;
}

/**
 * The owner's trigger rules (docs/launch-triggers.md), with the `launch-triggers` flag: which GitHub
 * events create a launch, and the channels of one whose repo has no launch.yml. The claim itself is
 * detect.ts' `claimEvent`, the one way an event becomes a launch whether it came by webhook or poll.
 */
export class TriggerService {
  readonly #deps: TriggerServiceDeps;

  constructor(deps: TriggerServiceDeps) {
    this.#deps = deps;
  }

  /** The rules in force: the owner's, or until they save some, the ones that decide as launch.yml alone did */
  async rules(): Promise<TriggerRule[]> {
    const stored = await this.#deps.registry.settings.setting<unknown>(TRIGGERS_SETTING);
    if (!Array.isArray(stored)) return DEFAULT_TRIGGER_RULES.map((r) => ({ ...r }));
    // A rule a later schema refuses is dropped, not the whole list: the others keep deciding
    return stored.flatMap((r) => {
      const parsed = TriggerRule.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /** Replaces the rules as a whole; refused (400) when one does not hold */
  async save(input: unknown): Promise<TriggerRule[]> {
    const parsed = TriggerRules.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new InvalidRequest(`trigger rules: ${issue ? `${issue.path.join('.') || 'the list'}: ${issue.message}` : 'invalid'}`);
    }
    await this.#deps.registry.settings.setSetting(TRIGGERS_SETTING, parsed.data);
    return parsed.data;
  }

  /** A launch claimed for a repo without launch.yml keeps its rule's channels, which its draft reads */
  async keepChannels(launchId: number, launchYml: string): Promise<void> {
    const config = parseLaunchConfig(launchYml);
    if (!config.ok) throw new Error('the rule’s channels do not parse as a launch.yml');
    await this.#deps.registry.launchStore.replaceChannels(launchId, channelRows(config.value), launchYml);
  }

  /** The channels kept for a launch, as launch.yml text, when its repo has none at the ref */
  async channelsText(launch: Pick<Launch, 'id'>): Promise<string | undefined> {
    return (await this.#deps.registry.launchStore.channels(launch.id)).source ?? undefined;
  }
}
