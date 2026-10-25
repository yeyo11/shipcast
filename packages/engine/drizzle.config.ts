import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @shipcast/engine db:generate` writes the SQL for a schema change into drizzle/,
// which is committed: the registry applies it at start, and an applied migration is never edited
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
