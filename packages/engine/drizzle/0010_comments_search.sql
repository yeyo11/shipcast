CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_text_trgm" ON "comments" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_author_handle_trgm" ON "comments" USING gin ("author_handle" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_author_name_trgm" ON "comments" USING gin ("author_name" gin_trgm_ops);
