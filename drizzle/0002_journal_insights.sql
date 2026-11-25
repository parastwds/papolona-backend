CREATE TABLE "journal_insights" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" text NOT NULL,
	"entries_hash" text NOT NULL,
	"refined" text NOT NULL,
	"key_points" text[] DEFAULT '{}'::text[] NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_insights_day_format" CHECK ("journal_insights"."day" ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint
ALTER TABLE "journal_insights" ADD CONSTRAINT "journal_insights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_insights_user_day_idx" ON "journal_insights" USING btree ("user_id","day");