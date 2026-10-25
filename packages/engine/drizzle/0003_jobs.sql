-- What the app shows of the queue's work: one row per pg-boss job, kept after it ends and across
-- restarts. pg-boss creates its own schema (pgboss) when it starts; nothing here touches it. See
-- docs/decisions/job-queue.md
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"title" text NOT NULL,
	"launch_id" integer,
	"state" text DEFAULT 'created' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"link" text,
	"created_at" text DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"started_at" text,
	"ended_at" text
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_by_created" ON "jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_by_launch" ON "jobs" USING btree ("launch_id");