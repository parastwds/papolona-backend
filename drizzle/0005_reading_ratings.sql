ALTER TABLE "clue_draws" ADD COLUMN "user_eeriness" integer;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD COLUMN "user_satisfaction" integer;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD COLUMN "rated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD COLUMN "ai_eeriness" integer;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD COLUMN "ai_satisfaction" integer;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD CONSTRAINT "clue_draws_ratings_check" CHECK (coalesce("clue_draws"."user_eeriness", 1) between 1 and 10 and coalesce("clue_draws"."user_satisfaction", 1) between 1 and 10 and coalesce("clue_draws"."ai_eeriness", 1) between 1 and 10 and coalesce("clue_draws"."ai_satisfaction", 1) between 1 and 10);