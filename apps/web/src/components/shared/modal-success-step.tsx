import * as React from 'react';
import { CheckCircle2 } from 'lucide-react';
import { ModalActions, OverlayHeader } from '@hushbox/ui';

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
      <div className="bg-success/10 mx-auto flex h-16 w-16 items-center justify-center rounded-full">
        <CheckCircle2 className="text-success h-8 w-8" />
      </div>

      <OverlayHeader title={heading} description={description} />

      <ModalActions
        primary={{
          label: primaryLabel,
          onClick: onDone,
        }}
      />
    </div>
  );
}
