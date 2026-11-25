CREATE TABLE "user_badges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"series_id" uuid,
	"badge" text NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_badges_badge_check" CHECK ("user_badges"."badge" in ('intuitive_insight', 'curated_collection', 'archive_edition', 'master_collection', 'founder'))
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_purpose_check";--> statement-breakpoint
ALTER TABLE "nft_series" DROP CONSTRAINT "nft_series_length_check";--> statement-breakpoint
ALTER TABLE "nft_series" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nft_series" ADD COLUMN "publish_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "nft_series" ADD COLUMN "mint_choice" text;--> statement-breakpoint
ALTER TABLE "nft_series" ADD COLUMN "mint_choice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_series_id_nft_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."nft_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_badges_series_badge_idx" ON "user_badges" USING btree ("series_id","badge");--> statement-breakpoint
CREATE UNIQUE INDEX "user_badges_one_founder_idx" ON "user_badges" USING btree ("user_id") WHERE "user_badges"."badge" = 'founder';--> statement-breakpoint
CREATE INDEX "user_badges_user_idx" ON "user_badges" USING btree ("user_id","awarded_at");--> statement-breakpoint
ALTER TABLE "nft_series" ADD CONSTRAINT "nft_series_publish_payment_id_payments_id_fk" FOREIGN KEY ("publish_payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nft_series_published_idx" ON "nft_series" USING btree ("published_at" DESC NULLS LAST) WHERE "nft_series"."published_at" is not null;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_purpose_check" CHECK ("payments"."purpose" in ('membership', 'publish'));--> statement-breakpoint
ALTER TABLE "nft_series" ADD CONSTRAINT "nft_series_mint_choice_check" CHECK ("nft_series"."mint_choice" is null or "nft_series"."mint_choice" in ('keep', 'mint', 'mint_poc'));--> statement-breakpoint
ALTER TABLE "nft_series" ADD CONSTRAINT "nft_series_length_check" CHECK ("nft_series"."length" in (1, 2, 3, 6, 12, 24));--> statement-breakpoint
-- New reward table: a twin series is common now (uncommon is the triple).
UPDATE "nft_series" SET "rarity" = 'common' WHERE "length" = 2 AND "rarity" = 'uncommon';--> statement-breakpoint
-- Series completed before badges existed earn theirs.
INSERT INTO "user_badges" ("user_id", "series_id", "badge", "awarded_at")
SELECT "user_id", "id", CASE "length" WHEN 6 THEN 'curated_collection' WHEN 12 THEN 'archive_edition' ELSE 'master_collection' END, "completed_at"
FROM "nft_series" WHERE "status" = 'completed' AND "length" IN (6, 12, 24)
ON CONFLICT DO NOTHING;
