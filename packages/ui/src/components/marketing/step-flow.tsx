import * as React from 'react';
import { cn } from '../../lib/utilities';

interface Step {
  title: string;
  description: string;
}

interface StepFlowProps extends React.ComponentProps<'div'> {
  steps: Step[];
  direction?: 'vertical' | 'horizontal';
  connected?: boolean;
  animated?: boolean;
  highlightStep?: number;
}

function StepFlow({
  steps,
  direction = 'vertical',
  connected = false,
  animated = false,
  highlightStep,
  className,
  ...props
}: Readonly<StepFlowProps>): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (!animated) return;
    const element = containerRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(element);
    return (): void => {
      observer.disconnect();
    };
  }, [animated]);

  return (
    <div
      ref={containerRef}
      data-slot="step-flow"
      data-direction={direction}
      {...(connected && { 'data-connected': '' })}
      {...(animated && { 'data-animated': '' })}
      {...(animated && { 'data-visible': String(visible) })}
      className={cn('flex gap-6', direction === 'vertical' ? 'flex-col' : 'flex-row', className)}
      {...props}
    >
      {steps.map((step, index) => (
        <div
          key={step.title}
          data-slot="step-item"
          className={cn(
            'flex items-start gap-3',
            highlightStep === index &&
              'border-primary bg-primary/5 rounded-r-lg border-l-2 py-2 pl-4'
          )}
          {...(animated && {
            style: { '--step-delay': `${String(index * 150)}ms` } as React.CSSProperties,
          })}
        >
          <span className="bg-primary text-primary-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold">
            {index + 1}
          </span>
          <div>
            <p className="font-semibold">{step.title}</p>
            <p className="text-muted-foreground text-sm">{step.description}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export { StepFlow, type StepFlowProps, type Step };
