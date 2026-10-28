import type { AccountStore } from '../ports.ts';
import type { Account } from '../registry.ts';

/**
 * The connected accounts as the owner manages them on the channels page: renaming one, and
 * choosing which account of a network publishes. Connecting and disconnecting go through the
 * runtime, which keeps the credentials in the secret store; this holds what is only rows.
 */
export class AccountService {
  readonly #store: AccountStore;

  constructor(store: AccountStore) {
    this.#store = store;
  }

  get(accountId: number): Promise<Account | undefined> {
    return this.#store.account(accountId);
  }

  /** The accounts, of one network or brand when asked, without their secrets: those live in the secret store, never in a row */
  list(filter: { brand?: string; network?: string } = {}): Promise<Account[]> {
    return this.#store.accounts(filter);
  }

  /** The account a brand publishes with on a network, if one is connected */
  primary(brand: string, network: string): Promise<Account | undefined> {
    return this.#store.primaryAccount(brand, network);
  }

  /** A label of the owner's own; an empty one is not taken (false), since an account needs a name to tell it apart */
  async rename(accountId: number, label: string): Promise<boolean> {
    const trimmed = label.trim();
    if (!trimmed) return false;
    await this.#store.updateAccount(accountId, { label: trimmed });
    return true;
  }

  /** The account its network publishes with from now on */
  async makePrimary(accountId: number): Promise<void> {
    await this.#store.makePrimary(accountId);
  }
}
