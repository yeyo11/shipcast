export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: RequestInit['body'];
}

/**
 * A fetch that answers by the first matching "METHOD url-prefix" rule, in order, and records every
 * request. A rule given as a list answers its responses one after another.
 */
export function fakeFetch(rules: Array<[string, () => Response]>, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    const rule = rules.find(([key]) => `${method} ${url}`.startsWith(key));
    if (!rule) throw new Error(`unexpected ${method} ${url}`);
    return rule[1]();
  }) as typeof fetch;
}

/** A response factory that hands out the given responses in turn, repeating the last. */
export function sequence(...responses: Array<() => Response>): () => Response {
  let i = 0;
  return () => responses[Math.min(i++, responses.length - 1)]!();
}
