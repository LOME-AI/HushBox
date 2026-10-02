-- Align live DB index name with Drizzle schema declaration.
-- Schema declares messages_conversation_sequence_idx (messages.ts:25);
-- migration 0008 created it as messages_conversation_id_sequence_idx.
ALTER INDEX "messages_conversation_id_sequence_idx" RENAME TO "messages_conversation_sequence_idx";
