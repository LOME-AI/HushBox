-- Add device_tokens table for push notification FCM token registration
CREATE TABLE device_tokens (
  id text PRIMARY KEY DEFAULT uuidv7(),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  platform text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_tokens_user_id_idx ON device_tokens (user_id);

-- Add muted column to conversation_members for push notification muting
ALTER TABLE conversation_members ADD COLUMN muted boolean NOT NULL DEFAULT false;
