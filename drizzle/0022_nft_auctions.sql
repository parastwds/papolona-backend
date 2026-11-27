CREATE TABLE "nft_bids" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"listing_id" uuid NOT NULL,
	"bidder_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nft_bids_amount_check" CHECK ("nft_bids"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "nft_listings" ADD COLUMN "collectors_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nft_bids" ADD CONSTRAINT "nft_bids_listing_id_nft_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."nft_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nft_bids" ADD CONSTRAINT "nft_bids_bidder_id_users_id_fk" FOREIGN KEY ("bidder_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nft_bids_listing_idx" ON "nft_bids" USING btree ("listing_id","amount_cents");