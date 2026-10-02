import * as React from 'react';
import { OTPInput, type SlotProps } from 'input-otp';
import { cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';

type OtpAppearance = 'dialog' | 'field';

interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  error?: string | null | undefined;
  /** `field` draws the cells like the auth form's inputs; `dialog` is the overlays' look. */
  appearance?: OtpAppearance;
  'aria-label'?: string;
  ref?: React.Ref<HTMLInputElement>;
  disabled?: boolean;
}

interface OtpLook {
  root: string;
  container: string;
  row: string;
  group: string;
  separator: string;
}

const LOOK: Readonly<Record<OtpAppearance, OtpLook>> = {
  dialog: {
    root: 'flex flex-col items-center gap-4 py-4',
    container: 'flex gap-2',
    row: 'flex gap-2',
    group: 'flex gap-1',
    separator: 'text-muted-foreground flex items-center',
  },
  field: {
    // The cells share the column's width and shrink together below it, so a narrow
    // column also tightens the gaps rather than squeezing the cells further.
    root: '@container flex w-full flex-col items-center gap-4 pt-3 pb-4',
    container: 'w-full',
    row: 'flex w-full items-center justify-center gap-2 @max-[18.5rem]:gap-1',
    group: 'flex max-w-36 min-w-0 flex-1 gap-1.5 @max-[18.5rem]:gap-1',
    separator: 'text-muted-foreground flex-none text-base leading-none',
  },
};

export function OtpInput({
  value,
  onChange,
  onComplete,
  error,
  appearance = 'dialog',
  'aria-label': ariaLabel,
  ref,
  disabled = false,
}: Readonly<OtpInputProps>): React.JSX.Element {
  const look = LOOK[appearance];
  return (
    <div className={look.root}>
      <OTPInput
        data-testid={TEST_IDS.otpInput}
        maxLength={6}
        value={value}
        onChange={onChange}
        {...(onComplete !== undefined && { onComplete })}
        {...(ariaLabel !== undefined && { 'aria-label': ariaLabel })}
        ref={ref}
        disabled={disabled}
        containerClassName={look.container}
        className="forced-color-adjust-none"
        // A browser may send no blur when a focused field is disabled; a disabled field
        // takes no digit, so no cell marks where the next one goes.
        render={({ slots }) => (
          <div className={look.row}>
            <div className={look.group}>
              {slots.slice(0, 3).map((slot, index) => (
                <Slot
                  key={index}
                  appearance={appearance}
                  {...slot}
                  isActive={slot.isActive && !disabled}
                />
              ))}
            </div>
            <span className={look.separator}>-</span>
            <div className={look.group}>
              {slots.slice(3).map((slot, index) => (
                <Slot
                  key={index + 3}
                  appearance={appearance}
                  {...slot}
                  isActive={slot.isActive && !disabled}
                />
              ))}
            </div>
          </div>
        )}
      />

      {error && (
        <p className="text-destructive text-sm" role={appearance === 'field' ? 'alert' : undefined}>
          {error}
        </p>
      )}
    </div>
  );
}

function Slot({
  appearance,
  ...props
}: Readonly<SlotProps & { appearance: OtpAppearance }>): React.JSX.Element {
  if (appearance === 'field') {
    return (
      <div
        className={cn(
          'flex h-14 max-w-11 min-w-0 flex-1 items-center justify-center rounded-lg border-2 bg-transparent text-xl leading-none font-medium tabular-nums transition-[border-color] duration-150',
          props.isActive
            ? 'border-primary outline-primary outline-2 outline-offset-2 outline-solid'
            : 'border-border-control'
        )}
      >
        {props.char ?? <span className="text-muted-foreground/30 text-lg">○</span>}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'border-input bg-background flex h-12 w-10 items-center justify-center rounded-md border text-lg font-medium',
        { 'ring-ring ring-2 outline-hidden': props.isActive }
      )}
    >
      {props.char ?? <span className="text-muted-foreground/30">○</span>}
    </div>
  );
}
