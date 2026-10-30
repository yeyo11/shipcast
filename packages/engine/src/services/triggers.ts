import { DEFAULT_TRIGGER_RULES, InvalidRequest, parseLaunchConfig, TriggerRule, TriggerRules } from '@shipcast/schema';
import { channelRows } from '../launch-store.ts';
import type { Launch, Repositories } from '../repositories/index.ts';

/** The setting the owner's trigger rules are kept under */
export const TRIGGERS_SETTING = 'triggers';

/** Moved to launch-keys.ts, so detect.ts does not import a service; re-exported for its callers */
export { ruleLaunchYml } from '../launch-keys.ts';

export interface TriggerServiceDeps {
  registry: Pick<Repositories, 'settings' | 'launchStore'>;
  /** Runs `work` in one transaction with every repository over it (`inTransaction`, from the composition root) */
  inTransaction<T>(work: (tx: Repositories) => Promise<T>): Promise<T>;
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

  /**
   * Claims a launch for a repo without launch.yml together with its rule's channels, which its draft
   * reads: one transaction, so a worker never picks up a claimed launch whose channels were not kept
   * yet, or never will be after a crash between the two writes
   */
  async claimKeeping(launch: Parameters<Repositories['launches']['claim']>[0], launchYml: string): Promise<{ claimed: boolean; launch: Launch }> {
    const config = parseLaunchConfig(launchYml);
    if (!config.ok) throw new Error('the rule’s channels do not parse as a launch.yml');
    return this.#deps.inTransaction(async (tx) => {
      const claimed = await tx.launches.claim(launch);
      if (claimed.claimed) await tx.launchStore.replaceChannels(claimed.launch.id, channelRows(config.value), launchYml);
      return claimed;
    });
  }

  /** The channels kept for a launch, as launch.yml text, when its repo has none at the ref */
  async channelsText(launch: Pick<Launch, 'id'>): Promise<string | undefined> {
    return (await this.#deps.registry.launchStore.channels(launch.id)).source ?? undefined;
  }
}
