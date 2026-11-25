ALTER TABLE "clue_draws" ADD COLUMN "prompt" jsonb;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD COLUMN "prompted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "clue_draws_user_prompted_idx" ON "clue_draws" USING btree ("user_id","prompted_at") WHERE "clue_draws"."prompted_at" is not null;