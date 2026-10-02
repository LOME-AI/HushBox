CREATE OR REPLACE FUNCTION validate_sender_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sender_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM users WHERE id = NEW.sender_id)
     OR EXISTS (SELECT 1 FROM shared_links WHERE id = NEW.sender_id) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'sender_id % does not exist in users or shared_links', NEW.sender_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_sender_id
  BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW
  EXECUTE FUNCTION validate_sender_id();
