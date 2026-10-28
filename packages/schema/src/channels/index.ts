// Zod-free at runtime: the web app's client code reads the channels through `@shipcast/schema/channels`
// (names, icons, limits, capabilities, draft files) without the pack's schema in the browser's bundle.
// The pieces' schemas are built by the main index (content-pack.ts), which has zod.
export * from './definition.ts';
export * from './registry.ts';
export * from './text.ts';
