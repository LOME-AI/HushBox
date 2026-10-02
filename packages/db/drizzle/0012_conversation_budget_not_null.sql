UPDATE conversations SET conversation_budget = '0.00000000' WHERE conversation_budget IS NULL;--> statement-breakpoint
ALTER TABLE conversations ALTER COLUMN conversation_budget SET NOT NULL;--> statement-breakpoint
ALTER TABLE conversations ALTER COLUMN conversation_budget SET DEFAULT '0.00000000';
