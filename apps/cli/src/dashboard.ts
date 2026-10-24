import { createServer, type Server } from 'node:http';
import type { Registry } from '@shipcast/engine';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en') : n.toFixed(2));

/** Everything the dashboard shows, as data: also served as JSON for other tools. */
export function dashboardData(registry: Registry) {
  return registry.recent(100).map((launch) => ({
    launch,
    posts: registry.posts(launch.id),
    metrics: registry.latestMetrics(launch.id),
  }));
}

/**
 * The dashboard's page: every launch with its pull request, where it was published, and the latest
 * reading of each metric by source. Plain, server-rendered HTML with no script; its look follows the
 * design system once it is settled.
 */
export function renderDashboard(registry: Registry): string {
  const rows = dashboardData(registry)
    .map(({ launch, posts, metrics }) => {
      const links = posts.map((p) => (p.url ? `<a href="${esc(p.url)}">${esc(p.channel)}</a>` : esc(p.channel))).join(' · ');
      const bySource = new Map<string, string[]>();
      for (const m of metrics) bySource.set(m.source, [...(bySource.get(m.source) ?? []), `${esc(m.name)} ${num(m.value)}`]);
      const numbers = [...bySource].map(([source, values]) => `<li><strong>${esc(source)}</strong> ${values.join(', ')}</li>`).join('');
      const pr = launch.detail?.startsWith('https://') ? `<a href="${esc(launch.detail)}">pull request</a>` : esc(launch.detail?.split('\n')[0] ?? '');
      return `<tr>
        <td><strong>${esc(launch.repo)}</strong> ${esc(launch.ref)}<br><small>${esc(launch.createdAt.slice(0, 16).replace('T', ' '))} · ${esc(launch.kind)}</small></td>
        <td>${esc(launch.status)}<br><small>${pr}</small></td>
        <td>${links || '<small>nothing published yet</small>'}</td>
        <td>${numbers ? `<ul>${numbers}</ul>` : '<small>no metrics yet</small>'}</td>
      </tr>`;
    })
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shipcast</title>
<style>
  :root { color-scheme: dark; font: 15px/1.5 system-ui, sans-serif; background: #111418; color: #e8ecef; }
  body { max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: .75rem .5rem; border-bottom: 1px solid #2a3038; }
  th { font-weight: 600; color: #a3acb4; }
  small { color: #a3acb4; }
  ul { margin: 0; padding-left: 1rem; }
  a { color: #8cc8ff; }
</style></head>
<body>
  <h1>Launches</h1>
  ${rows ? `<table><thead><tr><th>Launch</th><th>Status</th><th>Published on</th><th>Latest metrics</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No launches yet. Run <code>pnpm shipcast watch</code> and publish a release.</p>'}
</body></html>`;
}

/** Serves the dashboard on the loopback interface only: reach it from elsewhere through Tailscale Serve. */
export function serveDashboard(registry: Registry, port: number): Server {
  const server = createServer((request, response) => {
    if (request.url === '/api/launches') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(dashboardData(registry)));
      return;
    }
    if (request.url !== '/' && request.url !== '') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(renderDashboard(registry));
  });
  server.listen(port, '127.0.0.1');
  return server;
}
