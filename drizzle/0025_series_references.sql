ALTER TABLE "nft_series" ADD COLUMN "ref_seq" serial NOT NULL;--> statement-breakpoint
ALTER TABLE "nft_series" ADD COLUMN "ref_code" text DEFAULT 'ME' NOT NULL;--> statement-breakpoint
-- Existing series: numbered in the order they were started, coded by their maker's membership today.
UPDATE "nft_series" s SET "ref_seq" = r.n FROM (
  SELECT id, row_number() OVER (ORDER BY "created_at", id) AS n FROM "nft_series"
) r WHERE s.id = r.id;--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('nft_series', 'ref_seq'), COALESCE((SELECT max("ref_seq") FROM "nft_series"), 0) + 1, false);--> statement-breakpoint
UPDATE "nft_series" s SET "ref_code" = CASE u."membership_type"
  WHEN 'explorer' THEN 'EX' WHEN 'creator' THEN 'CR' WHEN 'collector' THEN 'CO' ELSE 'ME' END
FROM "users" u WHERE u.id = COALESCE(s."creator_id", s."user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nft_series_ref_seq_idx" ON "nft_series" USING btree ("ref_seq");
