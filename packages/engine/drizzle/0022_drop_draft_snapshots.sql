-- The one agreed exception to additive-only migrations (docs/decisions/launch-model.md, phase 8):
-- the drafts snapshot of the pull-request path, which nothing writes or reads since phase 8.
-- Dropped at the owner's decision on 2026-11-02, with no pg_dump step: he keeps his own backups.
DROP TABLE "draft_snapshots" CASCADE;