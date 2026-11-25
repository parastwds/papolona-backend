CREATE TABLE "nft_series" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"length" integer NOT NULL,
	"rows" integer NOT NULL,
	"cols" integer NOT NULL,
	"rarity" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"artwork_key" text NOT NULL,
	"reveal_order" integer[] NOT NULL,
	"revealed_tiles" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_reading_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nft_series_length_check" CHECK ("nft_series"."length" in (1, 2, 6, 12, 24)),
	CONSTRAINT "nft_series_grid_check" CHECK ("nft_series"."rows" * "nft_series"."cols" = "nft_series"."length"),
	CONSTRAINT "nft_series_rarity_check" CHECK ("nft_series"."rarity" in ('common', 'uncommon', 'rare', 'epic', 'legendary')),
	CONSTRAINT "nft_series_status_check" CHECK ("nft_series"."status" in ('active', 'completed', 'abandoned'))
);
--> statement-breakpoint
ALTER TABLE "clue_draws" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "clue_draws" ADD COLUMN "tile_index" integer;--> statement-breakpoint
ALTER TABLE "nft_series" ADD CONSTRAINT "nft_series_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nft_series_one_active_idx" ON "nft_series" USING btree ("user_id") WHERE "nft_series"."status" = 'active';--> statement-breakpoint
CREATE INDEX "nft_series_user_idx" ON "nft_series" USING btree ("user_id","started_at");--> statement-breakpoint
ALTER TABLE "clue_draws" ADD CONSTRAINT "clue_draws_series_id_nft_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."nft_series"("id") ON DELETE set null ON UPDATE no action;