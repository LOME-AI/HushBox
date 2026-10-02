ALTER TABLE conversation_members
  ADD COLUMN accepted_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
