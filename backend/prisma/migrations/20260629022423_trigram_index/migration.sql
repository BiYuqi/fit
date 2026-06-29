-- GIN trigram index on FoodStandard.name for pg_trgm fuzzy matching
CREATE INDEX food_standard_name_trgm
  ON "FoodStandard" USING gin (name gin_trgm_ops);