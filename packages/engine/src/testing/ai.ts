import { SdkProvider } from '../ai.ts';

// LEGACY (`@shipcast/engine/testing/legacy-ai`): the old provider's streaming mock; the runner's are in ai-runner.ts

/** What a mock streaming provider was asked, for assertions */
export interface StreamCall {
  system?: string;
  prompt?: string;
  messages?: unknown;
}

/**
 * A provider on the AI SDK's mock model that streams the given pieces of text: the real SdkProvider
 * code path, without a network. Every request is recorded in `calls`.
 */
export async function mockStreamingProvider(pieces: string[], calls: StreamCall[] = []): Promise<SdkProvider> {
  const { convertArrayToReadableStream, MockLanguageModelV4 } = await import('ai/test');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const system = options.prompt.find((m) => m.role === 'system');
      const users = options.prompt.filter((m) => m.role !== 'system');
      calls.push({
        ...(system && typeof system.content === 'string' && { system: system.content }),
        ...(users.length === 1 && users[0]!.role === 'user' && { prompt: users[0]!.content.map((p) => (p.type === 'text' ? p.text : '')).join('') }),
        messages: users,
      });
      return {
        stream: convertArrayToReadableStream([
          { type: 'text-start' as const, id: 't' },
          ...pieces.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
          { type: 'text-end' as const, id: 't' },
          { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
        ]),
      };
    },
  });
  return new SdkProvider({ id: 'test', model: () => model });
}
