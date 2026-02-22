import * as React from 'react';
import { ModalActions } from '@hushbox/ui';
import { CheckCircle2 } from 'lucide-react';

interface ModalSuccessStepProps {
  heading: string;
  description: string;
  primaryLabel: string;
  onDone: () => void;
}

export function ModalSuccessStep({
  heading,
  description,
  primaryLabel,
  onDone,
}: Readonly<ModalSuccessStepProps>): React.JSX.Element {
  return (
    <div className="space-y-4 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
        <CheckCircle2 className="h-8 w-8 text-green-500" />
      </div>

      <div>
        <h2 className="text-lg font-semibold">{heading}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{description}</p>
      </div>

      <ModalActions
        primary={{
          label: primaryLabel,
          onClick: onDone,
        }}
      />
    </div>
  );
}
