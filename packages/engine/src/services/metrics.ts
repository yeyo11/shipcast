import type { Brand } from '@shipcast/schema';
import { collectMetrics, type CollectResult, type MetricSources } from '../metrics.ts';
import type { MetricStore } from '../ports.ts';

/** The cursor that tells when the numbers were last read: the app shows it, the round paces itself by it */
export const METRICS_AT_KEY = 'metrics-collected-at';

/**
 * Reading every published launch's numbers now (docs/metrics.md): the metrics job, sent every six
 * hours or by hand from the CLI and the app, does it through here. The sources are the brand's
 * connectors, built by the caller; the store is the only other port.
 */
export class MetricsService {
  readonly #store: MetricStore;

  constructor(store: MetricStore) {
    this.#store = store;
  }

  /** Reads and records the numbers, and remembers when; one source failing never stops the others */
  async readNow(brand: Brand, sources: MetricSources, now = new Date()): Promise<CollectResult> {
    const result = await collectMetrics(this.#store, brand, sources, now);
    await this.#store.cursors.setCursor(METRICS_AT_KEY, now.toISOString());
    return result;
  }
}
