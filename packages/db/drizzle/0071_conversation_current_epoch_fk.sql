-- `conversations.current_epoch` names a row in `epochs`, so it is a foreign key
-- and is now declared as one. It is written by hand because the Drizzle
-- foreignKey builder exposes only onUpdate and onDelete, with no way to express
-- DEFERRABLE -- which the epoch-1 bootstrap below requires. The mutual reference
-- between the conversations and epochs modules is not the obstacle: it is
-- resolved the ordinary way, by annotating the referencing callback's return as
-- AnyPgColumn.
--
-- DEFERRABLE INITIALLY DEFERRED because the epoch-1 bootstrap writes the
-- conversation row before the epoch it points at; the pair only has to agree at
-- COMMIT. `title_epoch_number` is deliberately left unconstrained — it names a
-- historical epoch a member may no longer be able to read, and pinning it would
-- outlaw legal rows.
--
-- Added NOT VALID first so the ALTER takes no full-table validating lock and
-- cannot fail on a pre-existing row; VALIDATE then proves the existing rows and
-- flips the constraint to validated under a weaker lock.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_current_epoch_epochs_fk"
  FOREIGN KEY ("id", "current_epoch") REFERENCES "epochs" ("conversation_id", "epoch_number")
  DEFERRABLE INITIALLY DEFERRED NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_current_epoch_epochs_fk";
