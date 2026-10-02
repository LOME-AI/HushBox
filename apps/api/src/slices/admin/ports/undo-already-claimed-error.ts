/**
 * Thrown by the audit store when an undo's audit insert loses the
 * `admin_audit_undoes_unique` claim — the row being undone has already been
 * undone. The engine maps this to a `conflict` DomainError; the UNIQUE
 * constraint is what makes undo exactly-once (two concurrent undos of the
 * same row cannot both commit).
 */
export class UndoAlreadyClaimedError extends Error {
  constructor(undoes: string) {
    super(`admin audit row ${undoes} has already been undone`);
    this.name = 'UndoAlreadyClaimedError';
  }
}
