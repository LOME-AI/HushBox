-- Add pinned column to conversation_members for pinning conversations to top of sidebar
ALTER TABLE conversation_members ADD COLUMN pinned boolean NOT NULL DEFAULT false;
