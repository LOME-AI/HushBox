-- Carve-out: idempotency_keys.body_hash digests the request body a key row
-- deduplicates, and a chat turn's body carries its plaintext message, history
-- and custom instructions, so the panel never reads it. The 0050 blanket GRANT
-- SELECT ON ALL TABLES gave the panel this table; column privileges do not
-- subtract from a table-level grant, so the table-level REVOKE removes it and
-- column-scoped SELECT restores every other column. Consequence: SELECT * on
-- idempotency_keys is refused through the panel role.
REVOKE SELECT ON idempotency_keys FROM admin_sql_panel;--> statement-breakpoint
GRANT SELECT (id, user_id, route, key, kind, status, response, run_id, claims, claimed_by, claimed_at, completed_at, created_at)
  ON idempotency_keys TO admin_sql_panel;
