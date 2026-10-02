import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { cn } from '@hushbox/ui';
import { Swatch } from '@hushbox/ui/marks';
import { modelInfoFacts } from '@/lib/chat/model-info-facts';
import type { Model } from '@hushbox/shared';
import type { ModelInfoRate } from '@/lib/chat/model-info-facts';

interface ModelInfoProps {
  model: Model | undefined;
  selectionCount: number;
  signedIn: boolean;
}

/** Each token rate's label as shown, then the rest of the word a screen reader hears. */
const TOKEN_LABEL = { input: ['In', 'put'], output: ['Out', 'put'] } as const;

/**
 * The dot closes the fact before it behind a no-break space, so a wrapped line ends on a dot
 * and never starts with one.
 */
function Dot(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-slot="model-info-dot"
      className="text-ui-sm text-muted-foreground font-normal"
    >
      {'\u00A0•'}
    </span>
  );
}

function Fact({
  className,
  last,
  children,
}: Readonly<{ className?: string; last: boolean; children: React.ReactNode }>): React.JSX.Element {
  return (
    <span data-slot="model-info-fact" className={cn('inline-block max-w-full', className)}>
      {children}
      {last ? null : <Dot />}
    </span>
  );
}

/** A group keeps together while the column holds it and wraps whole where it doesn't. */
function Group({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <span data-slot="model-info-group" className="inline-block max-w-full">
      {children}
    </span>
  );
}

function Rate({ rate }: Readonly<{ rate: ModelInfoRate }>): React.JSX.Element {
  const figure = (
    <span
      data-slot="model-info-figure"
      className="text-caption text-foreground font-mono tabular-nums"
    >
      {rate.value}
    </span>
  );
  if (rate.kind === 'image') return figure;
  const [shown, rest] = TOKEN_LABEL[rate.kind];
  return (
    <>
      <span
        data-slot="model-info-label"
        className="text-caption font-mono tracking-[0.08em] uppercase"
      >
        {shown}
        <span className="sr-only">{rest}</span>
      </span>{' '}
      {figure}
    </>
  );
}

/**
 * The new chat's readout of the composer's model, under the greeting: the chip's swatch and
 * label, who makes the model (or the Smart Model's role), and an account's rates. The two
 * groups share a line where the column holds both, so a phone reads two lines.
 */
export function ModelInfo({
  model,
  selectionCount,
  signedIn,
}: Readonly<ModelInfoProps>): React.JSX.Element | null {
  if (model === undefined) return null;
  const { swatch, label, maker, rates } = modelInfoFacts(model, selectionCount, signedIn);
  const whoLast = rates.length === 0;

  return (
    <p
      data-testid={TEST_IDS.modelInfo}
      className="text-ui-sm text-muted-foreground m-0 text-center font-sans"
    >
      <Group>
        <Fact
          last={maker === undefined && whoLast}
          className="text-title-3 text-foreground inline-flex items-baseline *:data-[slot=swatch]:mr-2 *:data-[slot=swatch]:self-center"
        >
          <Swatch swatch={swatch} />
          <span className="min-w-0">{label}</span>
        </Fact>
        {maker === undefined ? null : (
          <>
            {' '}
            <Fact last={whoLast}>{maker}</Fact>
          </>
        )}
      </Group>
      {whoLast ? null : (
        <>
          {' '}
          <Group>
            {rates.map((rate, index) => (
              <React.Fragment key={rate.kind}>
                {index === 0 ? null : ' '}
                <Fact last={index === rates.length - 1}>
                  <Rate rate={rate} />
                </Fact>
              </React.Fragment>
            ))}
          </Group>
        </>
      )}
    </p>
  );
}
