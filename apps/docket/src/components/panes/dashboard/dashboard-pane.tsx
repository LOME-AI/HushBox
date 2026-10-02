import { DenseTable, StatTile } from '@hushbox/ui';
import { TEST_IDS } from '@/test-ids';
import { dashboardMetrics } from './dashboard-metrics';
import type { SectionId } from '@/components/shell/logic/sections';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

interface DashboardPaneProps {
  /** Every finding the filters admit, whatever state it is in. */
  readonly findings: readonly FindingJson[];
  /**
   * Where a figure the reader can act on sends them. Required rather than
   * optional: an optional one is assignable to a caller that never passes it, so
   * the wire could go dead with every gate still green.
   */
  readonly onSection: (section: SectionId) => void;
}

const SEVERITY_HEADERS = [{ label: 'Severity' }, { label: 'Remaining' }] as const;
const AREA_HEADERS = [{ label: 'Area' }, { label: 'Remaining' }] as const;

function Figure({
  label,
  value,
  testId,
}: Readonly<{ label: string; value: number; testId: string }>): JSX.Element {
  // The console ships no icon library, and a headline figure reads without one.
  return (
    <StatTile icon={null} label={label} value={String(value)} isLoading={false} testId={testId} />
  );
}

/**
 * A figure whose work is somewhere else. It is a button rather than a tile that
 * happens to answer a click, because a reader who cannot see the pointer has to
 * be told the number is a way in.
 */
function FigureLink({
  label,
  value,
  testId,
  onSelect,
}: Readonly<{ label: string; value: number; testId: string; onSelect: () => void }>): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="focus-visible:ring-ring rounded-xl text-left outline-none focus-visible:ring-2"
    >
      <Figure label={label} value={value} testId={testId} />
    </button>
  );
}

function Section({
  title,
  note,
  children,
}: Readonly<{ title: string; note?: string; children: JSX.Element }>): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-muted-foreground text-sm font-semibold uppercase">{title}</h3>
      {note !== undefined && <p className="text-muted-foreground text-sm">{note}</p>}
      {children}
    </section>
  );
}

/**
 * Where the reader is. The two decided figures are kept apart on purpose: most
 * of an audit is settled at emission, so folding those into one completion
 * number would read as progress the reader never made.
 */
export function DashboardPane({ findings, onSection }: DashboardPaneProps): JSX.Element {
  const metrics = dashboardMetrics(findings);

  return (
    <div data-testid={TEST_IDS.dashboardPane} className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure
          label="Awaiting your ruling"
          value={metrics.awaiting}
          testId={TEST_IDS.dashboardAwaiting}
        />
        <Figure
          label="Settled by the audit"
          value={metrics.settledByAudit}
          testId={TEST_IDS.dashboardSettled}
        />
        <Figure
          label="Decided by you"
          value={metrics.decidedByHuman}
          testId={TEST_IDS.dashboardDecided}
        />
        <FigureLink
          label="Blocked"
          value={metrics.blocked}
          testId={TEST_IDS.dashboardBlocked}
          onSelect={() => {
            onSection('blocked');
          }}
        />
        {/* Counted over the whole audit rather than over what is awaiting a
            ruling: a marked finding is owed a session whether or not it has
            been ruled, which is what the queue this opens holds. */}
        <FigureLink
          label="Needs a session"
          value={metrics.dedicated}
          testId={TEST_IDS.dashboardDedicated}
          onSelect={() => {
            onSection('dedicated');
          }}
        />
      </div>
      <p className="text-muted-foreground text-sm">
        The audit settles what it can on sight. Those findings are decided, but not by you.
      </p>

      {metrics.awaiting === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing is waiting on you.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Remaining by severity">
            <DenseTable
              testId={TEST_IDS.dashboardSeverity}
              label="Remaining by severity"
              headers={SEVERITY_HEADERS}
            >
              {metrics.bySeverity.map((row) => (
                <tr key={row.severity} className="border-border/60 border-b">
                  <td className="py-1 pr-2 text-sm">{row.severity}</td>
                  <td className="py-1 pr-2 font-mono text-sm tabular-nums">{row.count}</td>
                </tr>
              ))}
            </DenseTable>
          </Section>
          {/* The filter rail counts the same areas over one section, so the two
              disagree by design. A number that names its scope reads as a
              second reading rather than as one of the two being wrong. */}
          <Section
            title="Remaining by area"
            note="Counted over what is awaiting you, in every section."
          >
            <DenseTable
              testId={TEST_IDS.dashboardArea}
              label="Remaining by area"
              headers={AREA_HEADERS}
            >
              {metrics.byArea.map((row) => (
                <tr key={row.value} className="border-border/60 border-b">
                  {/* Areas are not guaranteed to be paths: the corpus carries
                      prose and `unknown`, so the cell wraps rather than clips. */}
                  <td className="py-1 pr-2 font-mono text-sm break-all">{row.value}</td>
                  <td className="py-1 pr-2 font-mono text-sm tabular-nums">{row.count}</td>
                </tr>
              ))}
            </DenseTable>
          </Section>
        </div>
      )}
    </div>
  );
}
