import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelPlan } from '@shipcast/runtime';
import { LaunchConfig } from '@shipcast/schema';
import { ACTION_CHANNELS, renderPublishWorkflow } from '../src/setup.ts';

// init offers what the Action publishes: each channel it sets up, with the secrets its workflow
// passes, is ready in the Action's own plan (packages/runtime/src/ci/config.ts)
test("init's channels are the Action's, and the secrets it writes are the ones the Action reads", () => {
  assert.deepEqual([...ACTION_CHANNELS], ['blog', 'devto', 'bluesky', 'mastodon', 'hashnode', 'telegram', 'discord', 'githubDiscussions']);
  for (const channel of ACTION_CHANNELS) {
    const workflow = renderPublishWorkflow({ channels: [channel] });
    const env = Object.fromEntries([...workflow.matchAll(/^ {10}([A-Z_]+): /gm)].map(([, name]) => [name!, 'set']));
    const config = LaunchConfig.parse({ enabled: true, brand: 'b', publishing: { blog: 'off', devto: 'off', bluesky: 'off', mastodon: 'off', instagram: 'off', githubDiscussions: 'off', [channel]: 'approval' } });
    const plan = channelPlan(config, env).find((p) => p.channel === channel);
    assert.equal(plan?.ready, true, `${channel}: ${plan?.note}`);
  }
});
