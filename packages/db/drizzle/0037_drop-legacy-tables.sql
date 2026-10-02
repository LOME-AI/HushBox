DO $$
DECLARE
	legacy_table text;
	populated text[] := ARRAY[]::text[];
	has_rows boolean;
BEGIN
	FOREACH legacy_table IN ARRAY ARRAY[
		'account_deletion_events',
		'content_items',
		'conversation_forks',
		'conversation_members',
		'conversation_spending',
		'conversations',
		'device_tokens',
		'epoch_members',
		'epochs',
		'ledger_entries',
		'llm_completions',
		'media_generations',
		'member_budgets',
		'messages',
		'payments',
		'projects',
		'service_evidence',
		'shared_links',
		'shared_messages',
		'usage_records',
		'users',
		'wallets'
	] LOOP
		EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', legacy_table) INTO has_rows;
		IF has_rows THEN
			populated := populated || legacy_table;
		END IF;
	END LOOP;
	IF array_length(populated, 1) IS NOT NULL THEN
		RAISE EXCEPTION 'legacy tables still hold rows: %', array_to_string(populated, ', ')
			USING HINT = 'This migration drops them and the next recreates them empty, so applying it here destroys that data. Restore the target database or empty these tables deliberately.';
	END IF;
END
$$;--> statement-breakpoint
DROP TABLE "account_deletion_events" CASCADE;--> statement-breakpoint
DROP TABLE "content_items" CASCADE;--> statement-breakpoint
DROP TABLE "conversation_forks" CASCADE;--> statement-breakpoint
DROP TABLE "conversation_members" CASCADE;--> statement-breakpoint
DROP TABLE "conversation_spending" CASCADE;--> statement-breakpoint
DROP TABLE "conversations" CASCADE;--> statement-breakpoint
DROP TABLE "device_tokens" CASCADE;--> statement-breakpoint
DROP TABLE "epoch_members" CASCADE;--> statement-breakpoint
DROP TABLE "epochs" CASCADE;--> statement-breakpoint
DROP TABLE "ledger_entries" CASCADE;--> statement-breakpoint
DROP TABLE "llm_completions" CASCADE;--> statement-breakpoint
DROP TABLE "media_generations" CASCADE;--> statement-breakpoint
DROP TABLE "member_budgets" CASCADE;--> statement-breakpoint
DROP TABLE "messages" CASCADE;--> statement-breakpoint
DROP TABLE "payments" CASCADE;--> statement-breakpoint
DROP TABLE "projects" CASCADE;--> statement-breakpoint
DROP TABLE "service_evidence" CASCADE;--> statement-breakpoint
DROP TABLE "shared_links" CASCADE;--> statement-breakpoint
DROP TABLE "shared_messages" CASCADE;--> statement-breakpoint
DROP TABLE "usage_records" CASCADE;--> statement-breakpoint
DROP TABLE "users" CASCADE;--> statement-breakpoint
DROP TABLE "wallets" CASCADE;