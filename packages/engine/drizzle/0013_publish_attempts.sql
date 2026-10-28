CREATE TABLE "publish_attempts" (
	"launch_id" integer NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"lease_until" text,
	"holder" text,
	"error" text,
	"external_id" text,
	"url" text,
	"started_at" text DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "publish_attempts_piece" PRIMARY KEY("launch_id","channel","kind")
);
--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publish_attempts_by_state" ON "publish_attempts" USING btree ("state");