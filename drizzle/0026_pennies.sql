CREATE TABLE "penny_transactions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"ref_id" uuid,
	"balance_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "penny_transactions_reason_check" CHECK ("penny_transactions"."reason" in ('welcome', 'daily_bonus', 'pack', 'reading', 'clue_prompt', 'message_request', 'conversion', 'membership', 'collector_fee', 'stone', 'donation', 'nft_purchase', 'bid_hold', 'bid_refund', 'nft_sale', 'refund', 'migration')),
	CONSTRAINT "penny_transactions_amount_check" CHECK ("penny_transactions"."amount" <> 0)
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_purpose_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_provider_check";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "wallet_cents" SET DEFAULT 1000;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "daily_bonus_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "creator_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "collector_nudged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "penny_transactions" ADD CONSTRAINT "penny_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "penny_transactions_user_idx" ON "penny_transactions" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_wallet_nonnegative" CHECK ("users"."wallet_cents" >= 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_purpose_check" CHECK ("payments"."purpose" in ('membership', 'publish', 'conversion', 'nft_purchase', 'stone', 'wallet_deposit', 'collector_fee', 'donation', 'penny_pack'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_check" CHECK ("payments"."provider" in ('demo', 'pennies'));--> statement-breakpoint
-- Everyone already here gets the 1,000 pennies new users start with, on top of their wallet (1 penny = 1 cent).
UPDATE "users" SET "wallet_cents" = "wallet_cents" + 1000;--> statement-breakpoint
INSERT INTO "penny_transactions" ("user_id", "amount", "reason", "balance_after")
SELECT "id", 1000, 'welcome', "wallet_cents" FROM "users";--> statement-breakpoint
-- Creators who joined before the provisional stage existed are full Creators.
UPDATE "users" SET "creator_confirmed_at" = coalesce("membership_type_since", "member_since", now())
WHERE "membership_type" = 'creator';--> statement-breakpoint
-- Listings are priced in pennies now, one penny for each cent they were priced at.
UPDATE "nft_listings" SET "currency" = 'PNY';
