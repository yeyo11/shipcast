-- Each account's followers, following and posts, one row a day from now on, and the picture the
-- last check found. Only adds: no existing row changes. See docs/decisions/account-snapshots.md
CREATE TABLE "account_snapshots" (
	"account_id" integer NOT NULL,
	"day" text NOT NULL,
	"taken_at" text NOT NULL,
	"followers" integer,
	"following" integer,
	"posts" integer,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "account_snapshots_account_day" PRIMARY KEY("account_id","day")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "account_snapshots" ADD CONSTRAINT "account_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;