/**
 * The share of its quota a provider says is used, from its answer's rate-limit headers: GitHub,
 * Mastodon and Bluesky send a limit and what remains (`x-ratelimit-*`, `ratelimit-*`), Meta a JSON of
 * percentages (`x-app-usage`, `x-business-use-case-usage`). Undefined when the answer says nothing.
 */
export interface Quota {
  /** 0 to 1 */
  used: number;
  limit?: number;
  /** When the window resets, in epoch milliseconds, when the answer says */
  reset?: number;
}

function number(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value.split(/[;,]/)[0]);
  return Number.isFinite(n) ? n : undefined;
}

function metaUsage(value: string | null): number | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    let peak: number | undefined;
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node && typeof node === 'object') {
        for (const [key, v] of Object.entries(node)) {
          if (typeof v === 'number' && /^(call_count|total_time|total_cputime|acc_id_util_pct)$/.test(key)) peak = Math.max(peak ?? 0, v / 100);
          else visit(v);
        }
      }
    };
    visit(parsed);
    return peak;
  } catch {
    return undefined;
  }
}

/**
 * GitHub and Bluesky send the reset as epoch seconds, the IETF draft as seconds from now, Mastodon as
 * an ISO date: a number too small to be an epoch is read as a delay.
 */
function resetOf(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = number(value);
  if (n !== undefined) return n > 1e9 ? n * 1000 : now + n * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : undefined;
}

export function quotaOf(headers: Headers, now: number = Date.now()): Quota | undefined {
  const limit = number(headers.get('x-ratelimit-limit')) ?? number(headers.get('ratelimit-limit'));
  const remaining = number(headers.get('x-ratelimit-remaining')) ?? number(headers.get('ratelimit-remaining'));
  if (limit !== undefined && remaining !== undefined && limit > 0) {
    const reset = resetOf(headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset'), now);
    return { used: Math.min(1, Math.max(0, (limit - remaining) / limit)), limit, ...(reset !== undefined && { reset }) };
  }
  const meta = [metaUsage(headers.get('x-app-usage')), metaUsage(headers.get('x-business-use-case-usage'))].filter((v) => v !== undefined);
  if (meta.length > 0) return { used: Math.min(1, Math.max(...meta)) };
  return undefined;
}
