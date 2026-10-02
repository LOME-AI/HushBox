import * as React from 'react';
import { z } from 'zod';
import { X } from 'lucide-react';
import { Button, CopyableId, IconButton, ScrollRegion } from '@hushbox/ui';
import { Badge } from '@hushbox/ui/marks';
import { TEST_IDS, adminAuditExecutedDetailsSchema, adminOpEffectSchema } from '@hushbox/shared';
import { useOps } from '@/hooks/use-ops';
import { useRunOp } from '@/components/ops/op-modal-provider';
import { formatTime } from '@/lib/format-time';
import { DiffList } from '@/components/ops/diff-list';
import { auditReasonOf, auditUndoFlow } from './audit-actions-table.js';
import type { AdminAuditRowWire, AdminOpEffect } from '@hushbox/shared';

interface AuditRowDrawerProps {
  readonly row: AdminAuditRowWire;
  readonly onClose: () => void;
  /** Jump to the other half of an undo pair (`undoes`/`undoneBy`). */
  readonly onJump: (auditId: string) => void;
}

const effectsSchema = z.array(adminOpEffectSchema);

/** The row's changed fields, when its details carry the executed shape. */
function effectsOf(details: unknown): readonly AdminOpEffect[] | null {
  const executed = adminAuditExecutedDetailsSchema.safeParse(details);
  if (!executed.success) {
    return null;
  }
  const effects = effectsSchema.safeParse(executed.data.effects);
  return effects.success ? effects.data : null;
}

function DrawerFact({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs uppercase">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function UndoPairLinks({
  row,
  onJump,
}: Readonly<{
  row: AdminAuditRowWire;
  onJump: (auditId: string) => void;
}>): React.JSX.Element | null {
  const { undoes, undoneBy } = row;
  if (undoes === null && undoneBy === null) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {undoes === null ? null : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            onJump(undoes);
          }}
        >
          Undoes {undoes.slice(0, 8)}
        </Button>
      )}
      {undoneBy === null ? null : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            onJump(undoneBy);
          }}
        >
          Undone by {undoneBy.slice(0, 8)}
        </Button>
      )}
    </div>
  );
}

/**
 * The audit trail's row inspection: the changed-fields view, the executed
 * reason, the undo threading, and the raw row behind a toggle. The panel shell
 * and its keyboard model belong to the layout around it.
 */
export function AuditRowDrawer({ row, onClose, onJump }: AuditRowDrawerProps): React.JSX.Element {
  const [showRaw, setShowRaw] = React.useState(false);
  const ops = useOps();
  const runOp = useRunOp();
  const undoFlow = auditUndoFlow(ops.data?.ops ?? [], row);
  const effects = effectsOf(row.details);
  const reason = auditReasonOf(row.details);

  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Badge tone="neutral">
            <span className="font-mono">{row.action}</span>
          </Badge>
          <span className="text-muted-foreground font-mono text-xs">
            {formatTime(row.createdAt, 'second')} UTC
          </span>
        </div>
        <IconButton aria-label="Close details" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      <dl className="flex flex-col gap-2">
        <DrawerFact label="Audit row">
          <CopyableId value={row.id} label="audit row id" />
        </DrawerFact>
        <DrawerFact label="Actor">
          <span className="font-mono text-xs">{row.actor}</span>
        </DrawerFact>
        <DrawerFact label="Role">
          <span className="text-xs">{row.role}</span>
        </DrawerFact>
        <DrawerFact label="Target">
          {row.targetType === null || row.targetId === null ? (
            <span className="text-muted-foreground text-xs">none</span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <span className="font-mono text-xs">{row.targetType}:</span>
              <CopyableId value={row.targetId} label="target id" />
            </span>
          )}
        </DrawerFact>
        <DrawerFact label="Reason">
          {reason ?? <span className="text-muted-foreground text-xs">none recorded</span>}
        </DrawerFact>
      </dl>

      <UndoPairLinks row={row} onJump={onJump} />

      <div>
        <h3 className="text-muted-foreground mb-1 text-xs font-semibold uppercase">
          Changed fields
        </h3>
        {effects === null ? (
          <p className="text-muted-foreground text-sm">No structured effects recorded.</p>
        ) : (
          <DiffList effects={effects} />
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {undoFlow === null ? null : (
          <Button
            data-testid={TEST_IDS.adminAuditUndo}
            size="sm"
            variant="outline"
            onClick={() => {
              runOp(undoFlow);
            }}
          >
            Undo
          </Button>
        )}
        <Button
          data-testid={TEST_IDS.adminAuditDrawerRaw}
          size="sm"
          variant="ghost"
          aria-pressed={showRaw}
          onClick={() => {
            setShowRaw((current) => !current);
          }}
        >
          Raw JSON
        </Button>
      </div>

      {showRaw ? (
        <ScrollRegion
          asChild
          label="Raw JSON"
          className="border-border max-h-80 overflow-auto rounded-md border p-2 font-mono text-xs"
        >
          <pre>{JSON.stringify(row, null, 2)}</pre>
        </ScrollRegion>
      ) : null}

      <p className="text-muted-foreground mt-auto text-xs">
        Arrow keys move between rows. Esc closes.
      </p>
    </>
  );
}
