ALTER TABLE "clue_draws" ADD COLUMN "question" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "photos" jsonb DEFAULT '[]'::jsonb NOT NULL;