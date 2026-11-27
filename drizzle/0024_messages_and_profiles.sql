CREATE TABLE "dm_threads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_a" uuid NOT NULL,
	"user_b" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"accepted_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"user_a_read_at" timestamp with time zone,
	"user_b_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_threads_status_check" CHECK ("dm_threads"."status" in ('pending', 'accepted', 'declined')),
	CONSTRAINT "dm_threads_order_check" CHECK ("dm_threads"."user_a" < "dm_threads"."user_b")
);
--> statement-breakpoint
CREATE TABLE "dm_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"thread_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id")
);
--> statement-breakpoint
CREATE TABLE "profile_access" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" uuid NOT NULL,
	"viewer_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_access_status_check" CHECK ("profile_access"."status" in ('pending', 'approved', 'denied'))
);
--> statement-breakpoint
ALTER TABLE "dm_threads" ADD CONSTRAINT "dm_threads_user_a_users_id_fk" FOREIGN KEY ("user_a") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_threads" ADD CONSTRAINT "dm_threads_user_b_users_id_fk" FOREIGN KEY ("user_b") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_threads" ADD CONSTRAINT "dm_threads_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_thread_id_dm_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."dm_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_access" ADD CONSTRAINT "profile_access_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_access" ADD CONSTRAINT "profile_access_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dm_threads_pair_idx" ON "dm_threads" USING btree ("user_a","user_b");--> statement-breakpoint
CREATE INDEX "dm_threads_user_b_idx" ON "dm_threads" USING btree ("user_b");--> statement-breakpoint
CREATE INDEX "dm_messages_thread_idx" ON "dm_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "user_blocks_blocked_idx" ON "user_blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_access_pair_idx" ON "profile_access" USING btree ("owner_id","viewer_id");--> statement-breakpoint
CREATE INDEX "profile_access_owner_status_idx" ON "profile_access" USING btree ("owner_id","status");