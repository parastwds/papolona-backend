CREATE TABLE "questionnaires" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"version" integer NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questionnaires_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"status" text DEFAULT 'probation' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"cohort" text,
	"readiness_tier" text,
	"segment_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"questionnaire_submission_id" uuid,
	"profile_bio" text DEFAULT '' NOT NULL,
	"profile_country" text,
	"profile_timezone" text,
	"profile_avatar_url" text,
	"profile_avatar_public_id" text,
	"notify_reading_reminders" boolean DEFAULT true NOT NULL,
	"notify_sequence_deadline" boolean DEFAULT true NOT NULL,
	"notify_product_updates" boolean DEFAULT true NOT NULL,
	"notify_marketing" boolean DEFAULT false NOT NULL,
	"reminder_time" text DEFAULT '09:00' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"legal_terms_version" text,
	"legal_privacy_version" text,
	"legal_accepted_at" timestamp with time zone,
	"next_clue_at" timestamp with time zone,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"lock_until" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('user', 'admin')),
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('probation', 'member', 'suspended', 'deleted')),
	CONSTRAINT "users_name_length" CHECK (char_length("users"."name") <= 80),
	CONSTRAINT "users_bio_length" CHECK (char_length("users"."profile_bio") <= 500)
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"email" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_pkey" PRIMARY KEY("provider","provider_id"),
	CONSTRAINT "user_identities_provider_check" CHECK ("user_identities"."provider" in ('google'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"family" text NOT NULL,
	"token_hash" text NOT NULL,
	"previous_token_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"ip" text,
	"user_agent" text,
	"platform" text,
	"app_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_revoked_reason_check" CHECK ("sessions"."revoked_reason" is null or "sessions"."revoked_reason" in ('logout', 'logout_all', 'password_changed', 'password_reset', 'token_reuse', 'account_deleted'))
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_changes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"value" text,
	"sent_to" text NOT NULL,
	CONSTRAINT "pending_changes_type_check" CHECK ("pending_changes"."type" in ('password', 'email', 'phone'))
);
--> statement-breakpoint
CREATE TABLE "questionnaire_submissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"questionnaire_version" integer NOT NULL,
	"answers" jsonb NOT NULL,
	"scores" jsonb NOT NULL,
	"cohort" text NOT NULL,
	"readiness_score" double precision,
	"readiness_tier" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"linked_user_id" uuid,
	"linked_at" timestamp with time zone,
	"device_id" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"document" text NOT NULL,
	"version" text NOT NULL,
	"context" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "legal_acceptances_document_check" CHECK ("legal_acceptances"."document" in ('terms', 'privacy')),
	CONSTRAINT "legal_acceptances_context_check" CHECK ("legal_acceptances"."context" in ('register', 'reaccept'))
);
--> statement-breakpoint
CREATE TABLE "content_pages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"version" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"title" text NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"video_url" text,
	"is_current" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_pages_key_check" CHECK ("content_pages"."key" in ('welcome', 'origin-story', 'terms', 'privacy'))
);
--> statement-breakpoint
CREATE TABLE "app_config" (
	"key" text PRIMARY KEY DEFAULT 'app' NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clue_draws" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"clue" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"next_available_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"client_id" text NOT NULL,
	"clue_draw_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_source_check" CHECK ("journal_entries"."source" in ('text', 'voice'))
);
--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_changes" ADD CONSTRAINT "pending_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_submissions" ADD CONSTRAINT "questionnaire_submissions_questionnaire_id_questionnaires_id_fk" FOREIGN KEY ("questionnaire_id") REFERENCES "public"."questionnaires"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_submissions" ADD CONSTRAINT "questionnaire_submissions_linked_user_id_users_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD CONSTRAINT "clue_draws_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_clue_draw_id_clue_draws_id_fk" FOREIGN KEY ("clue_draw_id") REFERENCES "public"."clue_draws"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_cohort_idx" ON "users" USING btree ("cohort");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_family_idx" ON "sessions" USING btree ("family");--> statement-breakpoint
CREATE INDEX "sessions_previous_token_hashes_idx" ON "sessions" USING gin ("previous_token_hashes");--> statement-breakpoint
CREATE INDEX "password_resets_user_idx" ON "password_resets" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "pending_changes_user_type_idx" ON "pending_changes" USING btree ("user_id","type","created_at");--> statement-breakpoint
CREATE INDEX "questionnaire_submissions_cohort_idx" ON "questionnaire_submissions" USING btree ("cohort");--> statement-breakpoint
CREATE INDEX "questionnaire_submissions_readiness_tier_idx" ON "questionnaire_submissions" USING btree ("readiness_tier");--> statement-breakpoint
CREATE INDEX "questionnaire_submissions_linked_user_idx" ON "questionnaire_submissions" USING btree ("linked_user_id");--> statement-breakpoint
CREATE INDEX "legal_acceptances_user_idx" ON "legal_acceptances" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_pages_key_locale_version_idx" ON "content_pages" USING btree ("key","locale","version");--> statement-breakpoint
CREATE INDEX "content_pages_current_idx" ON "content_pages" USING btree ("key","locale","is_current");--> statement-breakpoint
CREATE INDEX "clue_draws_user_generated_idx" ON "clue_draws" USING btree ("user_id","generated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_user_client_idx" ON "journal_entries" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE INDEX "journal_entries_user_id_idx" ON "journal_entries" USING btree ("user_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "journal_entries_user_clue_idx" ON "journal_entries" USING btree ("user_id","clue_draw_id");