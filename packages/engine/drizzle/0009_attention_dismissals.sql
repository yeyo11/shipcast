CREATE TABLE "attention_dismissals" (
	"key" text PRIMARY KEY NOT NULL,
	"dismissed_at" text DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
