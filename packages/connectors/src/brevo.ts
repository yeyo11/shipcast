import { checkProblem, ConnectorError, json, statsOf, type Check, type Metrics, type ProfileStats, type Published } from './http.ts';

export interface BrevoCampaign {
  /** The campaign's name in Brevo's dashboard, also its UTM campaign */
  name: string;
  subject: string;
  previewText: string;
  /** The finished email: Brevo sends this HTML as it is */
  html: string;
  sender: { name: string; email: string };
  /** Where replies go; the sender's own address unless said otherwise, never the account's default */
  replyTo?: string;
  listId: number;
  tag?: string;
}

interface GlobalStats {
  sent: number;
  delivered: number;
  uniqueViews: number;
  uniqueClicks: number;
  unsubscriptions: number;
  hardBounces: number;
  softBounces: number;
  complaints: number;
}

/**
 * Brevo's marketing API for the newsletter: a campaign created for one list and sent at once, its
 * numbers read back, and the size of a list, so an issue to nobody is never sent. Neither `edit` nor
 * `delete`: a sent campaign is in the readers' inboxes, which no API reaches.
 */
export class Brevo {
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(options: { apiKey: string; fetch?: typeof fetch; baseUrl?: string }) {
    this.#key = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = options.baseUrl ?? 'https://api.brevo.com/v3';
  }

  #request(method: string, path: string, body?: unknown): Promise<Response> {
    return this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { 'api-key': this.#key, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** The key's account */
  async check(): Promise<Check> {
    try {
      const account = await json<{ email: string; companyName?: string }>('Brevo', await this.#request('GET', '/account'), 'check');
      return { ok: true, account: account.companyName ? `${account.companyName} (${account.email})` : account.email };
    } catch (error) {
      return checkProblem(error);
    }
  }

  /** Contacts in a list who can still receive it */
  async subscribers(listId: number): Promise<number> {
    const list = await json<{ uniqueSubscribers: number; totalBlacklisted: number }>('Brevo', await this.#request('GET', `/contacts/lists/${listId}`), 'read the list');
    return Math.max(0, list.uniqueSubscribers - list.totalBlacklisted);
  }

  /** The newsletter's readers: every list's contacts who can still receive it, added up */
  async profileStats(): Promise<ProfileStats> {
    const { lists } = await json<{ lists?: Array<{ uniqueSubscribers?: number; totalBlacklisted?: number }> }>('Brevo', await this.#request('GET', '/contacts/lists?limit=50'), 'read the lists');
    const subscribers = (lists ?? []).reduce((sum, l) => sum + Math.max(0, (l.uniqueSubscribers ?? 0) - (l.totalBlacklisted ?? 0)), 0);
    return statsOf({ followers: subscribers });
  }

  /** Creates the campaign and sends it now. Its id is what the metrics are read with. */
  async send(campaign: BrevoCampaign): Promise<Published> {
    const created = await json<{ id: number }>(
      'Brevo',
      await this.#request('POST', '/emailCampaigns', {
        name: campaign.name,
        subject: campaign.subject,
        previewText: campaign.previewText,
        sender: campaign.sender,
        replyTo: campaign.replyTo ?? campaign.sender.email,
        htmlContent: campaign.html,
        recipients: { listIds: [campaign.listId] },
        ...(campaign.tag ? { tag: campaign.tag } : {}),
      }),
      'create the campaign',
    );
    const sent = await this.#request('POST', `/emailCampaigns/${created.id}/sendNow`);
    if (sent.status !== 204) {
      // The campaign stays as a draft in Brevo; a retry would create a second one, so say so
      throw new ConnectorError('Brevo', `send campaign ${created.id}, left as a draft: ${sent.status} ${(await sent.text()).slice(0, 300)}`, sent.status, false);
    }
    return { externalId: String(created.id), url: `https://app.brevo.com/marketing-campaign/report/${created.id}` };
  }

  /** Sends a campaign to test addresses only, to check how it reads before anything real goes out */
  async sendTest(campaignId: number, emails: string[]): Promise<void> {
    const response = await this.#request('POST', `/emailCampaigns/${campaignId}/sendTest`, { emailTo: emails });
    if (response.status !== 204) throw new ConnectorError('Brevo', `test send: ${response.status} ${(await response.text()).slice(0, 300)}`, response.status);
  }

  /**
   * The numbers of many campaigns from Brevo's list of sent campaigns with their global statistics,
   * a hundred a call, newest first, until every one asked for is found (five pages at most). Brevo's
   * list keeps statistics for six months only: a campaign the list has no statistics for is read on
   * its own. An id of several (`12,13`, one issue per language) adds its campaigns up.
   */
  async metricsMany(externalIds: readonly string[]): Promise<Map<string, Metrics>> {
    const wanted = new Set(externalIds.flatMap((id) => id.split(',')));
    const found = new Map<string, Metrics>();
    for (let page = 0; page < 5 && [...wanted].some((id) => !found.has(id)); page++) {
      const answer = await json<{ campaigns?: Array<{ id: number; statistics?: { globalStats?: GlobalStats } }> }>(
        'Brevo',
        await this.#request('GET', `/emailCampaigns?status=sent&statistics=globalStats&limit=100&offset=${page * 100}&sort=desc`),
        'metrics',
      );
      const campaigns = answer.campaigns ?? [];
      for (const c of campaigns) {
        const s = c.statistics?.globalStats;
        if (s && wanted.has(String(c.id))) found.set(String(c.id), statsOfCampaign(s));
      }
      if (campaigns.length < 100) break;
    }
    for (const id of wanted) if (!found.has(id)) found.set(id, await this.metrics(id));
    const out = new Map<string, Metrics>();
    for (const externalId of externalIds) {
      const total: Metrics = {};
      for (const id of externalId.split(',')) for (const [name, value] of Object.entries(found.get(id) ?? {})) total[name] = (total[name] ?? 0) + value;
      out.set(externalId, total);
    }
    return out;
  }

  /**
   * A campaign's numbers. Opens are unique opens, which Apple's privacy protection inflates; clicks
   * are the number to trust.
   */
  async metrics(externalId: string): Promise<Metrics> {
    // One issue per language is one campaign each, recorded as `12,13`: their numbers add up
    if (externalId.includes(',')) {
      const total: Metrics = {};
      for (const id of externalId.split(',')) {
        for (const [name, value] of Object.entries(await this.metrics(id))) total[name] = (total[name] ?? 0) + value;
      }
      return total;
    }
    const campaign = await json<{ statistics?: { globalStats?: GlobalStats } }>(
      'Brevo',
      await this.#request('GET', `/emailCampaigns/${externalId}?statistics=globalStats`),
      'metrics',
    );
    const s = campaign.statistics?.globalStats;
    return s ? statsOfCampaign(s) : {};
  }
}

/** A campaign's numbers. Opens are unique opens, which Apple's privacy protection inflates; clicks are the number to trust */
function statsOfCampaign(s: GlobalStats): Metrics {
  return {
    sent: s.sent,
    delivered: s.delivered,
    opens: s.uniqueViews,
    clicks: s.uniqueClicks,
    unsubscribes: s.unsubscriptions,
    bounces: s.hardBounces + s.softBounces,
    complaints: s.complaints,
  };
}
