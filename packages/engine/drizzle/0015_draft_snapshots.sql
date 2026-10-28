CREATE TABLE "draft_snapshots" (
	"launch_id" integer PRIMARY KEY NOT NULL,
	"pr_number" integer NOT NULL,
	"url" text NOT NULL,
	"branch" text NOT NULL,
	"head_sha" text,
	"state" text NOT NULL,
	"launch_yml" text,
	"files" jsonb NOT NULL,
	"read_at" text DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draft_snapshots" ADD CONSTRAINT "draft_snapshots_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE no action ON UPDATE no action;