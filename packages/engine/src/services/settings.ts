import type { SettingStore } from '../ports.ts';

/**
 * The owner's choices kept as setting rows (the onboarding's progress, the automation mode once
 * chosen): read and written by key, for the pages that hold no rule of their own about them. The
 * settings with rules of their own have them in their modules (ai-settings.ts, comments.ts,
 * schedule.ts's time zone), each over this same port.
 */
export class SettingsService {
  readonly #store: SettingStore;

  constructor(store: SettingStore) {
    this.#store = store;
  }

  read<T>(key: string): Promise<T | undefined> {
    return this.#store.setting<T>(key);
  }

  save(key: string, value: unknown): Promise<void> {
    return this.#store.setSetting(key, value);
  }
}
