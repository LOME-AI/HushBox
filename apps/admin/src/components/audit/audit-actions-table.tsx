import * as React from 'react';
import { Button, ScrollRegion, cn } from '@hushbox/ui';
import { Badge } from '@hushbox/ui/marks';
import { TEST_IDS, adminAuditExecutedDetailsSchema } from '@hushbox/shared';
import { useOps } from '@/hooks/use-ops';
import { useRunOp } from '@/components/ops/op-modal-provider';
import { formatTime } from '@/lib/format-time';
import { toFormValues } from '@/lib/op-fields';
import type { AdminAuditRowWire, AdminOpWire } from '@hushbox/shared';
import type { OpFlowStart } from '@/components/ops/op-modal';

/**
 * The inverse flow a feed row's Undo starts, or null when the row is not
 * undoable: the wire carries `details.inverseInput` (the engine writes it
 * for every executed effect) and the ops catalog names the inverse; a
 * read-audit or refusal row fails the details parse, an action the catalog
 * gives no inverse (an op that registers none, or an action the catalog does
 * not carry) has nothing to run, and `undoneBy` marks a row whose undo
 * already committed.
 */
export function auditUndoFlow(
  ops: readonly AdminOpWire[],
  row: AdminAuditRowWire
): OpFlowStart | null {
  if (row.undoneBy !== null) {
    return null;
  }
  const inverse = ops.find((op) => op.name === row.action)?.inverse;
  if (inverse == null) {
    return null;
  }
  const details = adminAuditExecutedDetailsSchema.safeParse(row.details);
  if (!details.success || details.data.inverseInput === null) {
    return null;
  }
  return {
    opName: inverse,
    initialValues: toFormValues(details.data.inverseInput),
    undoes: row.id,
  };
}

/** The executed input's reason, when the row's details carry one. */
export function auditReasonOf(details: unknown): string | null {
  if (typeof details !== 'object' || details === null || !('input' in details)) {
    return null;
  }
  const input = (details as { input: unknown }).input;
  if (typeof input !== 'object' || input === null || !('reason' in input)) {
    return null;
  }
  const reason = (input as { reason: unknown }).reason;
  return typeof reason === 'string' ? reason : null;
}

function UndoCell({
  row,
  flow,
}: Readonly<{ row: AdminAuditRowWire; flow: OpFlowStart | null }>): React.JSX.Element | null {
  const runOp = useRunOp();
  if (flow !== null) {
    return (
      <Button
        data-testid={TEST_IDS.adminAuditUndo}
        size="sm"
        variant="outline"
        onClick={() => {
          runOp(flow);
        }}
      >
        Undo
      </Button>
    );
  }
  if (row.undoneBy !== null) {
    return <span className="text-muted-foreground text-xs">undone</span>;
  }
  return null;
}

/**
 * Actor and the role they acted as, stacked in one cell rather than given a
 * column: the role is an attribute of that identity at that instant (an
 * actor's mapping can change), and the two panels that embed this table are
 * narrow. The role is a word, so it is set in the UI sans rather than the
 * mono the email identifier takes, and it is spelled out on every row —
 * absence would be indistinguishable from an operator row.
 */
function ActorCell({ row }: Readonly<{ row: AdminAuditRowWire }>): React.JSX.Element {
  return (
    <td className="py-1 pr-2">
      <span className="block font-mono text-xs">{row.actor}</span>
      <span className="text-muted-foreground block text-xs">
        <span className="sr-only">acting as</span>
        {row.role}
      </span>
    </td>
  );
}

function TargetCell({ row }: Readonly<{ row: AdminAuditRowWire }>): React.JSX.Element {
  const target = row.targetType === null ? null : `${row.targetType}:${row.targetId ?? ''}`;
  return (
    // nowrap, never break-all: a wrapped uuid reads as two ids (same rule as
    // CopyableId); the table's overflow container scrolls instead.
    <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap" title={target ?? undefined}>
      {target}
    </td>
  );
}

function AuditRow({
  row,
  onInspect,
  inspected,
}: Readonly<{
  row: AdminAuditRowWire;
  onInspect?: ((row: AdminAuditRowWire) => void) | undefined;
  inspected?: boolean | undefined;
}>): React.JSX.Element {
  const ops = useOps();
  const undoFlow = auditUndoFlow(ops.data?.ops ?? [], row);
  return (
    // aria-current, not aria-selected: selection is a grid's contract, and a
    // plain table offers none of the keyboard navigation that would promise.
    // Inspection marks which row of the set the details panel is showing.
    <tr
      {...(inspected === true && { 'aria-current': true })}
      className={cn('border-border border-b', inspected === true && 'bg-accent')}
    >
      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">{formatTime(row.createdAt)}</td>
      <td className="py-1 pr-2">
        <span className="inline-flex items-center gap-1">
          <Badge tone="neutral">
            <span className="font-mono">{row.action}</span>
          </Badge>
          {row.undoes === null ? null : (
            <Badge tone="secondary" title={`Undoes audit row ${row.undoes}`}>
              undo
            </Badge>
          )}
        </span>
      </td>
      <ActorCell row={row} />
      <TargetCell row={row} />
      <td className="text-muted-foreground max-w-64 truncate py-1 pr-2 text-xs">
        {auditReasonOf(row.details) ?? ''}
      </td>
      <td className="py-1 text-right">
        <span className="inline-flex items-center gap-1">
          {onInspect === undefined ? null : (
            <Button
              data-testid={TEST_IDS.adminAuditInspect}
              size="sm"
              variant="ghost"
              onClick={() => {
                onInspect(row);
              }}
            >
              Details
            </Button>
          )}
          <UndoCell row={row} flow={undoFlow} />
        </span>
      </td>
    </tr>
  );
}

/**
 * The admin-actions feed: every screen that renders admin history shares
 * this table, including the inline Undo affordance (the inverse op through
 * the OpModal, linked via `undoes`).
 */
export function AuditActionsTable({
  rows,
  onInspect,
  inspectedId,
}: Readonly<{
  rows: readonly AdminAuditRowWire[];
  /** Wires the audit-trail drawer: renders a Details affordance per row. */
  onInspect?: ((row: AdminAuditRowWire) => void) | undefined;
  inspectedId?: string | undefined;
}>): React.JSX.Element {
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-sm">No admin actions yet.</p>;
  }
  return (
    // Wide-table rule: the table scrolls in its own container so no consumer
    // (dashboard, Customer 360, audit trail) ever scrolls the page sideways.
    <ScrollRegion label="Admin actions" className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-muted-foreground border-border border-b text-xs uppercase">
            <th className="py-1 pr-2 font-medium">When</th>
            <th className="py-1 pr-2 font-medium">Action</th>
            <th className="py-1 pr-2 font-medium">Actor</th>
            <th className="py-1 pr-2 font-medium">Target</th>
            <th className="py-1 pr-2 font-medium">Reason</th>
            <th className="py-1 font-medium">
              <span className="sr-only">Undo</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <AuditRow
              key={row.id}
              row={row}
              onInspect={onInspect}
              inspected={inspectedId === row.id}
            />
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
