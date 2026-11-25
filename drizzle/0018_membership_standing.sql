ALTER TABLE "payments" DROP CONSTRAINT "payments_purpose_check";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "membership_type_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "wallet_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_purpose_check" CHECK ("payments"."purpose" in ('membership', 'publish', 'conversion', 'nft_purchase', 'stone', 'wallet_deposit', 'collector_fee'));--> statement-breakpoint
-- Existing members start their first two-month period now, rather than being judged on the past.
UPDATE "users" SET "membership_type_since" = now() WHERE "membership_type" IS NOT NULL;
