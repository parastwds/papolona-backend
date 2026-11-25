CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"remind_at" timestamp with time zone NOT NULL,
	"repeat" text DEFAULT 'none' NOT NULL,
	"time_zone" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminders_repeat_check" CHECK ("reminders"."repeat" in ('none', 'daily', 'weekly', 'monthly')),
	CONSTRAINT "reminders_title_length" CHECK (char_length("reminders"."title") between 1 and 120),
	CONSTRAINT "reminders_note_length" CHECK (char_length("reminders"."note") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reading_reminder_sent_on" text;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("active","remind_at");--> statement-breakpoint
CREATE INDEX "reminders_user_idx" ON "reminders" USING btree ("user_id","remind_at");