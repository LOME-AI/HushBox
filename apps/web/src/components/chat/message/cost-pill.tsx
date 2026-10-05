import * as React from 'react';
import { formatNanoUsdCost, NanoUSD, TEST_IDS } from '@hushbox/shared';
import { ChevronDown, Icon } from '@hushbox/ui/icons';
import { Popover } from '@hushbox/ui/popover';

interface CostPillProps {
  /** Billed cost as a canonical NanoUSD wire string (e.g. "1360000" = $0.00136). */
  cost: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

const TITLE = 'This reply';

/**
 * The transcript's scroller, which the message list marks with this slot. The breakdown stays
 * inside it, opening above the pill near the thread's end and never over the sidebar.
 */
const TRANSCRIPT_SCROLLER = '[data-slot="scroll-area-viewport"]';

/**
 * The pill keeps the drawn height of the meta line, and a coarse pointer reaches it
 * through an invisible layer extended to the touch floor.
 */
const PILL_CLASS =
  'relative inline-flex h-6 items-center gap-1 rounded-full border border-border bg-transparent ps-2 pe-1.5 font-mono text-caption tabular-nums text-foreground transition-colors duration-150 hover:border-border-control hover:bg-accent aria-expanded:border-border-control aria-expanded:bg-accent pointer-coarse:before:absolute pointer-coarse:before:-inset-x-1 pointer-coarse:before:-inset-y-2.5';

function formatTokenCount(count: number): string {
  return `${count.toLocaleString('en-US')} tokens`;
}

function Row({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </>
  );
}

/**
 * A reply's cost as a pill that opens what the reply used: its input and output tokens,
 * each where the read served it, and the cost. The pill carries the reply's own figure
 * and nothing else as its text, which is what a reader summing the thread's costs reads.
 *
 * `formatNanoUsdCost` throws on a non-canonical NanoUSD string, so the pill guards with a
 * safe parse: a malformed cost draws nothing rather than taking the message list down.
 */
export function CostPill({
  cost,
  inputTokens,
  outputTokens,
}: Readonly<CostPillProps>): React.JSX.Element | null {
  const [transcript, setTranscript] = React.useState<HTMLElement | null>(null);
  const findTranscript = React.useCallback((pill: HTMLButtonElement | null): void => {
    setTranscript(pill?.closest<HTMLElement>(TRANSCRIPT_SCROLLER) ?? null);
  }, []);
  if (!NanoUSD.safeParse(cost).success) return null;
  const figure = formatNanoUsdCost(cost);

  return (
    <Popover
      title={TITLE}
      align="start"
      boundary={transcript}
      trigger={
        <button
          ref={findTranscript}
          type="button"
          aria-label={`Cost ${figure}, show breakdown`}
          data-testid={TEST_IDS.messageCost}
          className={PILL_CLASS}
        >
          {figure}
          <Icon icon={ChevronDown} size="xs" className="text-muted-foreground" />
        </button>
      }
    >
      <div className="flex flex-col gap-1.5">
        {/* Below 768 the sheet head carries the title, so the label would repeat it. */}
        <p className="hidden font-semibold md:block">{TITLE}</p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
          {inputTokens !== undefined && <Row label="Input" value={formatTokenCount(inputTokens)} />}
          {outputTokens !== undefined && (
            <Row label="Output" value={formatTokenCount(outputTokens)} />
          )}
          <Row label="Cost" value={figure} />
        </dl>
      </div>
    </Popover>
  );
}
