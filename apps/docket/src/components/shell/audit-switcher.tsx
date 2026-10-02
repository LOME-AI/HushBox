import { TEST_IDS } from '@/test-ids';
import type { JSX } from 'react';

interface AuditSwitcherProps {
  readonly name: string;
  /** Every audit directory found beside the loaded one, newest first. */
  readonly audits: readonly string[];
  /** Where a chosen audit goes; the parent that owns the address bar routes it. */
  readonly onSwitch: (name: string) => void;
  /** A bulk ruling is working its way down the queue. */
  readonly bulkRunning: boolean;
}

const SELECT_ID = 'audit-switcher';
const HELD_ID = 'audit-switcher-held';
/**
 * Every write of a bulk ruling lands in the audit it was started against, so
 * the hold is not about correctness: switching mid-plan takes away the summary
 * of what the plan ruled, which is the only place that count is reported.
 */
const HELD_REASON = 'Switching is held until the bulk ruling finishes.';

/** Which audit is loaded, which others exist, and the way between them. */
export function AuditSwitcher({
  name,
  audits,
  onSwitch,
  bulkRunning,
}: AuditSwitcherProps): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={SELECT_ID} className="sr-only">
        Audit
      </label>
      <select
        id={SELECT_ID}
        data-testid={TEST_IDS.auditSwitcher}
        value={name}
        disabled={bulkRunning}
        {...(bulkRunning ? { 'aria-describedby': HELD_ID } : {})}
        onChange={(event) => {
          // Landing back on the audit already on screen is not a switch, and
          // routing it as one would clear the reader's filters for nothing.
          if (event.target.value === name) return;
          onSwitch(event.target.value);
        }}
        className="border-border bg-card text-foreground focus-visible:ring-ring rounded-md border px-2 py-1 font-mono text-sm outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {audits.map((audit) => (
          <option key={audit} value={audit}>
            {audit}
          </option>
        ))}
      </select>
      {bulkRunning && (
        <span id={HELD_ID} className="text-muted-foreground text-sm">
          {HELD_REASON}
        </span>
      )}
    </div>
  );
}
