ALTER TABLE "nft_series" DROP CONSTRAINT "nft_series_rarity_check";--> statement-breakpoint
-- New tiers: 3 common, 6 epic, 12 mythic, 24 legendary (singles and twins stay common, as practice).
UPDATE "nft_series" SET "rarity" = CASE "length" WHEN 6 THEN 'epic' WHEN 12 THEN 'mythic' WHEN 24 THEN 'legendary' ELSE 'common' END;--> statement-breakpoint
-- 3 and 6 series earn a butterfly emblem now: give the ones started without one a random artwork.
UPDATE "nft_series" SET "artwork_key" = 'butterfly_' || lpad((floor(random() * 15) + 1)::int::text, 2, '0') WHERE "length" IN (3, 6) AND "artwork_key" = 'none';--> statement-breakpoint
ALTER TABLE "nft_series" ADD CONSTRAINT "nft_series_rarity_check" CHECK ("nft_series"."rarity" in ('common', 'epic', 'mythic', 'legendary'));
