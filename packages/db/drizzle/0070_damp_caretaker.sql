CREATE INDEX "verification_tokens_expires_at_idx" ON "verification_tokens" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "allowance_spending" ADD CONSTRAINT "allowance_spending_day_calendar" CHECK (to_date("allowance_spending"."day", 'YYYY-MM-DD') IS NOT NULL);--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ADD CONSTRAINT "newsletter_subscribers_suppression_consistency" CHECK (("newsletter_subscribers"."suppressed_at" IS NULL) = ("newsletter_subscribers"."suppress_reason" IS NULL));--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_quiet_hours_range" CHECK (("notification_preferences"."quiet_hours_start_minutes" IS NULL OR "notification_preferences"."quiet_hours_start_minutes" BETWEEN 0 AND 1439) AND ("notification_preferences"."quiet_hours_end_minutes" IS NULL OR "notification_preferences"."quiet_hours_end_minutes" BETWEEN 0 AND 1439));--> statement-breakpoint
-- Carve-out: the wrapped private keys are end-to-end key material, offline-
-- attackable by the same argument that made users.opaque_registration
-- unreadable in 0050 — which granted them by column list. The grant is already
-- column-scoped, so narrowing it is a column-level REVOKE rather than a new
-- role or a re-grant. Consequence: SELECT * on users stays refused, and key
-- presence is not panel-readable at all — column-level SELECT is required to
-- reference a column in any expression, so `password_wrapped_private_key IS
-- NOT NULL` is refused exactly as the bare column is. A view projecting the
-- boolean would be the mechanism if a support flow ever needs one; none does,
-- so none exists.
REVOKE SELECT (password_wrapped_private_key, recovery_wrapped_private_key)
  ON users FROM admin_sql_panel;--> statement-breakpoint
-- 0027 created validate_sender_id() with a check_sender_id trigger on
-- messages; 0037 dropped messages CASCADE, which took the trigger and left the
-- function. Nothing calls it. It is not reattachable: it passes a sender_id
-- only if it matches a users or shared_links row, and the assistant sender is
-- a sentinel matching neither, so restoring the trigger would refuse every
-- assistant message.
DROP FUNCTION IF EXISTS validate_sender_id();
