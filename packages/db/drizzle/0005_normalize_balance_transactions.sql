-- Custom migration: Normalize balance_transactions description column
-- Replace composite description string with structured columns

-- Step 1: Create the deduction_source enum
CREATE TYPE "deduction_source" AS ENUM ('balance', 'freeAllowance');
--> statement-breakpoint

-- Step 2: Add new columns (nullable initially)
ALTER TABLE "balance_transactions" ADD COLUMN "model" text;
--> statement-breakpoint
ALTER TABLE "balance_transactions" ADD COLUMN "input_characters" integer;
--> statement-breakpoint
ALTER TABLE "balance_transactions" ADD COLUMN "output_characters" integer;
--> statement-breakpoint
ALTER TABLE "balance_transactions" ADD COLUMN "deduction_source" "deduction_source";
--> statement-breakpoint

-- Step 3: Migrate existing data from description column
-- For usage transactions, parse the description string
UPDATE "balance_transactions"
SET
  model = regexp_replace(description, '^AI response: ([^ ]+) \(.*', '\1'),
  output_characters = (regexp_replace(description, '.*\((\d+) chars\).*', '\1'))::integer,
  input_characters = 0,
  deduction_source = CASE
    WHEN description LIKE '%free allowance%' THEN 'freeAllowance'::"deduction_source"
    ELSE 'balance'::"deduction_source"
  END
WHERE type = 'usage' AND description LIKE 'AI response:%';
--> statement-breakpoint

-- Step 4: Drop the description column
ALTER TABLE "balance_transactions" DROP COLUMN "description";
