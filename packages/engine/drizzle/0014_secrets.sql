CREATE TABLE "secrets" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"sealed" text NOT NULL,
	"sealed_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" text DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
