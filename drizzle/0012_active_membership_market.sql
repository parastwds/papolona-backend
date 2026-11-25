CREATE TABLE "stone_orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"payment_id" uuid,
	"recipient_name" text NOT NULL,
	"address_line1" text NOT NULL,
	"address_line2" text DEFAULT '' NOT NULL,
	"city" text NOT NULL,
	"postcode" text NOT NULL,
	"country" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nft_listings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"series_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"buyer_id" uuid,
	"sale_payment_id" uuid,
	"fee_cents" integer,
	"seller_proceeds_cents" integer,
	"sold_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nft_listings_status_check" CHECK ("nft_listings"."status" in ('active', 'sold', 'cancelled')),
	CONSTRAINT "nft_listings_price_check" CHECK ("nft_listings"."price_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_purpose_check";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "active_reminder_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nft_series" ADD COLUMN "creator_id" uuid;--> statement-breakpoint
ALTER TABLE "nft_series" ADD COLUMN "converted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nft_series" ADD COLUMN "conversion_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "stone_orders" ADD CONSTRAINT "stone_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stone_orders" ADD CONSTRAINT "stone_orders_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nft_listings" ADD CONSTRAINT "nft_listings_series_id_nft_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."nft_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nft_listings" ADD CONSTRAINT "nft_listings_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nft_listings" ADD CONSTRAINT "nft_listings_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nft_listings" ADD CONSTRAINT "nft_listings_sale_payment_id_payments_id_fk" FOREIGN KEY ("sale_payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stone_orders_user_idx" ON "stone_orders" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nft_listings_one_active_idx" ON "nft_listings" USING btree ("series_id") WHERE "nft_listings"."status" = 'active';--> statement-breakpoint
CREATE INDEX "nft_listings_active_idx" ON "nft_listings" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "nft_listings_seller_idx" ON "nft_listings" USING btree ("seller_id","created_at");--> statement-breakpoint
ALTER TABLE "nft_series" ADD CONSTRAINT "nft_series_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nft_series" ADD CONSTRAINT "nft_series_conversion_payment_id_payments_id_fk" FOREIGN KEY ("conversion_payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_purpose_check" CHECK ("payments"."purpose" in ('membership', 'publish', 'conversion', 'nft_purchase', 'stone'));--> statement-breakpoint
-- Every series so far is still with the member who made it.
UPDATE "nft_series" SET "creator_id" = "user_id" WHERE "creator_id" IS NULL;--> statement-breakpoint
-- Series minted before conversions were paid count as converted (no payment, so they do not keep anyone active).
UPDATE "nft_series" SET "converted_at" = "mint_choice_at" WHERE "mint_choice" IN ('mint', 'mint_poc') AND "converted_at" IS NULL;
