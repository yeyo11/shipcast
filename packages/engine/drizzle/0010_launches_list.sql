CREATE INDEX "launches_by_newest" ON "launches" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "launches_by_status" ON "launches" USING btree ("status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "launches_by_repo" ON "launches" USING btree ("repo","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);