import * as React from 'react';
import { cn } from '@hushbox/ui';

interface Step {
  title: string;
  description: string;
}

interface StepFlowProps extends React.ComponentProps<'ol'> {
  steps: Step[];
  direction?: 'vertical' | 'horizontal';
  connected?: boolean;
  highlightStep?: number;
}

function StepFlow({
  steps,
  direction = 'vertical',
  connected = false,
  highlightStep,
  className,
  ...props
}: Readonly<StepFlowProps>): React.JSX.Element {
  return (
    <ol
      data-slot="step-flow"
      data-direction={direction}
      {...(connected && { 'data-connected': '' })}
      className={cn('flex gap-6', direction === 'vertical' ? 'flex-col' : 'flex-row', className)}
      {...props}
    >
      {steps.map((step, index) => (
        <li
          key={step.title}
          data-slot="step-item"
          // `step` rather than `true`: the highlight names where the reader is
          // within an ordered process, which is exactly what this value means.
          {...(highlightStep === index && { 'aria-current': 'step' as const })}
          className={cn(
            'flex items-start gap-3',
            highlightStep === index &&
              'border-primary bg-primary/5 -ml-4 rounded-r-lg border-l-2 py-2 pl-4'
          )}
        >
          <span className="bg-primary text-primary-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold">
            {index + 1}
          </span>
          <div>
            <p className="font-semibold">{step.title}</p>
            <p className="text-muted-foreground text-sm">{step.description}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export { StepFlow };
