-- Eight cohorts become four (questionnaire v4): Creator, Collector, Patron, Explorer.
-- Creator – Revenue joins Creator, Investor joins Collector, Brand joins Patron (organisations wanting work
-- made for them), Institution joins Explorer. Past questionnaire submissions keep the cohort they were
-- scored with under their own version.
UPDATE "users" SET "cohort" = CASE "cohort"
  WHEN 'creator_visibility' THEN 'creator'
  WHEN 'creator_revenue' THEN 'creator'
  WHEN 'collector_acquisition' THEN 'collector'
  WHEN 'investor_value' THEN 'collector'
  WHEN 'patron_commission' THEN 'patron'
  WHEN 'brand_partnership' THEN 'patron'
  WHEN 'institution_exhibition' THEN 'explorer'
  ELSE "cohort"
END
WHERE "cohort" IN ('creator_visibility', 'creator_revenue', 'collector_acquisition', 'investor_value',
  'patron_commission', 'brand_partnership', 'institution_exhibition');
