CREATE TABLE "metric_days" (
	"launch_id" integer NOT NULL,
	"post_id" integer,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"day" text NOT NULL,
	"value" double precision NOT NULL,
	"read_at" text NOT NULL,
	CONSTRAINT "metric_days_unique" UNIQUE NULLS NOT DISTINCT("launch_id","post_id","source","name","day")
);
--> statement-breakpoint
ALTER TABLE "metric_days" ADD CONSTRAINT "metric_days_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_days" ADD CONSTRAINT "metric_days_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "metric_days_by_launch" ON "metric_days" USING btree ("launch_id","source","name","day");--> statement-breakpoint
-- The one stored reading that already says its day: a repo's traffic and stars kept as `views:<day>`
-- (and visitors, clones, cloners, stars), the newest reading of each day
INSERT INTO "metric_days" ("launch_id", "post_id", "source", "name", "day", "value", "read_at")
SELECT DISTINCT ON ("launch_id", "name", "day") "launch_id", NULL, 'github', "name", "day", "value", coalesce("checked_at", "taken_at")
FROM (
  SELECT "launch_id", split_part("name", ':', 1) AS "name", split_part("name", ':', 2) AS "day", "value", "taken_at", "checked_at"
  FROM "metrics"
  WHERE "source" = 'github' AND "post_id" IS NULL AND "name" ~ '^(views|visitors|clones|cloners|stars):\d{4}-\d{2}-\d{2}$'
) AS "dated"
ORDER BY "launch_id", "name", "day", "taken_at" DESC
ON CONFLICT DO NOTHING;
