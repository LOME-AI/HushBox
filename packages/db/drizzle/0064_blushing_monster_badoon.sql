DROP INDEX "newsletter_deliveries_issue_id_idx";--> statement-breakpoint
DROP INDEX "wallets_user_id_idx";--> statement-breakpoint
CREATE INDEX "device_tokens_last_seen_at_idx" ON "device_tokens" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "newsletter_subscribers_topic_status_idx" ON "newsletter_subscribers" USING btree ("topic","status");