-- 1. Add modelName column for AI messages
ALTER TABLE messages ADD COLUMN model_name TEXT;
UPDATE messages SET model_name = 'AI' WHERE sender_type = 'ai';
ALTER TABLE messages ADD CONSTRAINT messages_ai_model_name_check
  CHECK (sender_type != 'ai' OR model_name IS NOT NULL);

-- 2. Backfill guest senderId from NULL to their conversation_members.id
UPDATE messages m
  SET sender_id = cm.id
  FROM conversation_members cm
  WHERE m.conversation_id = cm.conversation_id
    AND m.sender_display_name IS NOT NULL
    AND m.sender_id IS NULL
    AND cm.user_id IS NULL
    AND cm.link_id IS NOT NULL;

-- 3. Drop senderDisplayName column
ALTER TABLE messages DROP COLUMN sender_display_name;
