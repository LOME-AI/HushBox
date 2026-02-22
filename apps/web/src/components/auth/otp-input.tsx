import * as React from 'react';
import { OTPInput, type SlotProps } from 'input-otp';
import { cn } from '@hushbox/ui';

interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  error?: string | null | undefined;
}

export function OtpInput({
  value,
  onChange,
  onComplete,
  error,
}: Readonly<OtpInputProps>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 py-4">
      <OTPInput
        data-testid="otp-input"
        maxLength={6}
        value={value}
        onChange={onChange}
        {...(onComplete !== undefined && { onComplete })}
        containerClassName="flex gap-2"
        render={({ slots }) => (
          <div className="flex gap-2">
            <div className="flex gap-1">
              {slots.slice(0, 3).map((slot, index) => (
                <Slot key={index} {...slot} />
              ))}
            </div>
            <span className="text-muted-foreground flex items-center">-</span>
            <div className="flex gap-1">
              {slots.slice(3).map((slot, index) => (
                <Slot key={index + 3} {...slot} />
              ))}
            </div>
          </div>
        )}
      />

      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}

function Slot(props: Readonly<SlotProps>): React.JSX.Element {
  return (
    <div
      className={cn(
        'border-input bg-background flex h-12 w-10 items-center justify-center rounded-md border text-lg font-medium',
        { 'ring-ring ring-2': props.isActive }
      )}
    >
      {props.char ?? <span className="text-muted-foreground/30">○</span>}
    </div>
  );
}
