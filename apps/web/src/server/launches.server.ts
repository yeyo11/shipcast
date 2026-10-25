import type { Launch, Registry } from '@shipcast/engine';
import type { LaunchView, Tone } from './view';

function stateOf(launch: Launch, failures: number): { label: string; tone: Tone } {
  switch (launch.status) {
    case 'detected':
    case 'generating':
      return { label: 'Drafting', tone: 'draft' };
    case 'drafted':
      return failures > 0 ? { label: 'Partly published', tone: 'failed' } : { label: 'Waiting for you', tone: 'waiting' };
    case 'published':
      return { label: 'Published', tone: 'published' };
    case 'skipped':
      return { label: 'Not launched', tone: 'manual' };
    default:
      return { label: 'Failed', tone: 'failed' };
  }
}

/** The numbers worth a glance on a launch's card */
const HEADLINE: Array<[string, string, string]> = [
  ['blog', 'views', 'blog views'],
  ['github', 'stars', 'stars'],
  ['devto', 'views', 'dev.to views'],
  ['newsletter', 'clicks', 'newsletter clicks'],
];

export async function launchView(registry: Registry, launch: Launch): Promise<LaunchView> {
  const [cursors, metrics, posts] = await Promise.all([
    registry.cursorsWithPrefix(`publish-failed:${launch.id}:`),
    registry.latestMetrics(launch.id),
    registry.posts(launch.id),
  ]);
  const failures = cursors.map((c) => ({ channel: c.key.split(':')[2] ?? '', message: c.value }));
  const pullRequest = launch.detail?.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
  return {
    id: launch.id,
    repo: launch.repo,
    ref: launch.ref,
    kind: launch.kind,
    trigger: launch.trigger,
    status: launch.status,
    state: stateOf(launch, failures.length),
    pullRequest,
    problem: launch.status === 'failed' ? (launch.detail ?? undefined) : undefined,
    createdAt: launch.createdAt,
    posts: posts.map((p) => ({ id: p.id, channel: p.channel, kind: p.kind, url: p.url, publishedAt: p.publishedAt })),
    failures,
    headline: HEADLINE.flatMap(([source, name, label]) => {
      const found = metrics.find((m) => m.source === source && m.name === name);
      return found ? [{ label, value: found.value }] : [];
    }),
  };
}
