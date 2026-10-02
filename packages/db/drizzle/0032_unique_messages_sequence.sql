-- Promote (conversation_id, sequence_number) to a UNIQUE index.
-- Defense-in-depth: assignSequenceNumbers atomically increments nextSequence,
-- but a unique constraint guarantees no two rows can ever share the pair.
-- Pre-launch: hard rebuild is fine.
DROP INDEX "messages_conversation_sequence_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_sequence_idx"
  ON "messages" USING btree ("conversation_id", "sequence_number");
