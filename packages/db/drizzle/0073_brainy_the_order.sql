ALTER TABLE "users" ADD COLUMN "opaque_server_material" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "opaque_kek_fingerprint" "bytea" NOT NULL;--> statement-breakpoint
-- Carve-out: opaque_server_material is the per-user OPAQUE server material
-- (sealed, yet offline-attackable by the argument that made
-- users.opaque_registration unreadable in 0050), and opaque_kek_fingerprint
-- names the key that sealed it. 0050 granted users by column list, and a
-- column added later joins no such list, so the panel already cannot read
-- these; the REVOKE records the decision in the chain instead of resting on
-- that default. Consequence: SELECT * on users stays refused, and presence is
-- not panel-readable at all — column-level SELECT is required to reference a
-- column in any expression.
REVOKE SELECT (opaque_server_material, opaque_kek_fingerprint)
  ON users FROM admin_sql_panel;
