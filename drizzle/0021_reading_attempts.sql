ALTER TABLE "nft_series" DROP CONSTRAINT "nft_series_status_check";--> statement-breakpoint
ALTER TABLE "clue_draws" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD COLUMN "deadline_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nft_series" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nft_series" ADD CONSTRAINT "nft_series_status_check" CHECK ("nft_series"."status" in ('active', 'completed', 'abandoned', 'failed'));--> statement-breakpoint
-- Readings judged before resubmissions existed had their one attempt.
UPDATE "clue_draws" SET "attempts" = 1 WHERE "verdict" IS NOT NULL;
