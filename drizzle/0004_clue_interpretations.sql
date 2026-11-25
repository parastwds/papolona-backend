ALTER TABLE "clue_draws" ADD COLUMN "interpretation" text;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD COLUMN "interpretation_source" text;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD COLUMN "verdict" text;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD COLUMN "judgement" jsonb;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD COLUMN "judged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD CONSTRAINT "clue_draws_verdict_check" CHECK ("clue_draws"."verdict" is null or "clue_draws"."verdict" in ('pass', 'fail'));--> statement-breakpoint
ALTER TABLE "clue_draws" ADD CONSTRAINT "clue_draws_source_check" CHECK ("clue_draws"."interpretation_source" is null or "clue_draws"."interpretation_source" in ('text', 'voice'));