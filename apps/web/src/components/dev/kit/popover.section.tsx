import * as React from 'react';
import { Button } from '@hushbox/ui/button';
import { KeyRound, Lock, ShieldCheck } from '@hushbox/ui/icons';
import {
  Popover,
  PopoverFact,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  type PopoverProps,
} from '@hushbox/ui/popover';
import type { KitSection } from './kit-sections';

const RATIOS = [
  '1:1',
  '4:5',
  '3:4',
  '2:3',
  '9:16',
  '5:4',
  '4:3',
  '3:2',
  '16:9',
  '21:9',
  '1:2',
  '2:1',
  '9:19.5',
  '19.5:9',
  '9:20',
  '20:9',
  '9:21',
  'Auto',
] as const;

const BRANCHES = ['Main', 'Shorter answer', 'With citations'] as const;

interface SampleProps extends Omit<PopoverProps, 'trigger'> {
  /** The trigger's label, and the note beside it. */
  label: string;
  note: string;
}

function Sample({ label, note, ...popover }: Readonly<SampleProps>): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-caption text-muted-foreground font-mono">{note}</p>
      <div>
        <Popover trigger={<Button variant="outline">{label}</Button>} {...popover} />
      </div>
    </div>
  );
}

function ReplyFacts(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {/* Below 768 the sheet head carries the title, so the label would repeat it. */}
      <p className="hidden text-sm font-semibold md:block">This reply</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Input</dt>
        <dd className="text-end font-mono tabular-nums">1,862 tokens</dd>
        <dt className="text-muted-foreground">Output</dt>
        <dd className="text-end font-mono tabular-nums">412 tokens</dd>
        <dt className="text-muted-foreground">Cost</dt>
        <dd className="text-end font-mono tabular-nums">$0.0118</dd>
      </dl>
    </div>
  );
}

function RatioGrid(): React.JSX.Element {
  return (
    <div role="group" aria-label="Ratios" className="grid grid-cols-4 gap-1.5 md:grid-cols-6">
      {RATIOS.map((ratio) => (
        <Button key={ratio} variant="outline" size="sm" aria-pressed={ratio === '1:1'}>
          {ratio}
        </Button>
      ))}
    </div>
  );
}

/** A narrow column with its trigger at the far end, so the popover has to shift to stay inside. */
function ColumnSample(): React.JSX.Element {
  const [column, setColumn] = React.useState<HTMLElement | null>(null);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-caption text-muted-foreground font-mono">
        25rem, held inside a 28rem column
      </p>
      <div
        ref={setColumn}
        className="flex min-h-48 max-w-md items-start justify-end rounded-md border border-dashed p-2"
      >
        <Popover
          trigger={<Button variant="outline">In the column</Button>}
          title="Held in the column"
          width="lg"
          align="end"
          boundary={column}
        >
          <p>It shifts along the column rather than past its edge.</p>
        </Popover>
      </div>
    </div>
  );
}

function PopoverSamples(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-6">
        <Sample label="This reply" note="18rem, the default" title="This reply">
          <ReplyFacts />
        </Sample>
        <Sample label="Storage" note="fact lines" title="Storage">
          <div className="flex flex-col gap-2.5">
            <PopoverFact icon={Lock}>Saved encrypted</PopoverFact>
            <PopoverFact icon={KeyRound}>
              Encrypted with this conversation&apos;s key, which only its members hold
            </PopoverFact>
            <PopoverFact icon={ShieldCheck}>Deleted with the conversation</PopoverFact>
          </div>
        </Sample>
        <Sample label="Branches" note="23rem" title="Branches" width="md">
          <ul className="flex flex-col gap-1">
            {BRANCHES.map((branch) => (
              <li key={branch} className="py-1">
                {branch}
              </li>
            ))}
          </ul>
        </Sample>
        <Sample
          label="Aspect ratio"
          note="25rem, flips only when short"
          title="Aspect ratio"
          width="lg"
        >
          <RatioGrid />
        </Sample>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-caption text-muted-foreground font-mono">tooltip, 16rem at most</p>
          <div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline">Long tooltip</Button>
              </TooltipTrigger>
              <TooltipContent>
                We only partner with AI providers that never store or train on your data.
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
      <ColumnSample />
    </div>
  );
}

const section: KitSection = {
  title: 'Popovers',
  part: 6,
  render: () => <PopoverSamples />,
};

export default section;
