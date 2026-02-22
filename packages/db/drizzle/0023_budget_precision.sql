-- Constrain budget limits to 2 decimal places (cents precision)
-- Spending columns stay at numeric(20, 8) for full sub-cent precision
ALTER TABLE member_budgets
  ALTER COLUMN budget TYPE numeric(20, 2);

ALTER TABLE conversations
  ALTER COLUMN conversation_budget TYPE numeric(20, 2);

-- Drop dead column — never used in billing/display
ALTER TABLE conversations DROP COLUMN per_person_budget;
