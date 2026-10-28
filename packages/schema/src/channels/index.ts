// Zod-free at runtime: the web app's client code reads the channels through `@shipcast/schema/channels`
// (names, icons, limits, capabilities, draft files) without the pack's schema in the browser's bundle.
// The pieces' schemas are built by the main index (content-pack.ts), which has zod.
export * from './definition.ts';
export * from './registry.ts';
export * from './text.ts';
// Each channel's definition on its own, for its adapter half in packages/runtime/src/channels, which
// is typed against the definition's literal id
export { blog } from './blog.ts';
export { bluesky } from './bluesky.ts';
export { devto } from './devto.ts';
export { discord } from './discord.ts';
export { githubDiscussions } from './github-discussions.ts';
export { hashnode } from './hashnode.ts';
export { instagram } from './instagram.ts';
export { linkedin } from './linkedin.ts';
export { mastodon } from './mastodon.ts';
export { newsletter } from './newsletter.ts';
export { reddit } from './reddit.ts';
export { telegram } from './telegram.ts';
export { threads } from './threads.ts';
