-- 1. Add parent_message_id column (self-referencing FK, nullable)
ALTER TABLE "messages" ADD COLUMN "parent_message_id" TEXT REFERENCES "messages"("id") ON DELETE SET NULL;

-- 2. Backfill: wire up parent chain from existing linear sequence order
-- Idempotent: LAG returns NULL for first message (already correct),
-- re-running on already-backfilled data produces identical result
WITH ordered AS (
  SELECT id,
    LAG(id) OVER (PARTITION BY conversation_id ORDER BY sequence_number) AS prev_id
  FROM messages
)
UPDATE messages SET parent_message_id = ordered.prev_id
FROM ordered WHERE messages.id = ordered.id;

-- 3. Index on parent_message_id (created after backfill to avoid slowing the UPDATE)
CREATE INDEX "messages_parent_message_id_idx" ON "messages"("parent_message_id");

-- 4. Forks table
CREATE TABLE "conversation_forks" (
  "id" TEXT PRIMARY KEY DEFAULT uuidv7(),
  "conversation_id" TEXT NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "tip_message_id" TEXT REFERENCES "messages"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "conversation_forks_conv_name_idx"
  ON "conversation_forks"("conversation_id", "name");
CREATE INDEX "conversation_forks_conv_idx"
  ON "conversation_forks"("conversation_id");
