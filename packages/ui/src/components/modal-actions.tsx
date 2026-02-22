import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/utilities';
import { Button } from './button';

export interface ModalActionButton {
  /** Button display text. */
  label: string;
  /** Click handler. */
  onClick: () => void;
  /** Button variant. Primary defaults to 'default', cancel defaults to 'outline'. */
  variant?: 'default' | 'destructive' | 'outline';
  /** Disable the button. */
  disabled?: boolean;
  /** Show Loader2 spinner and optionally swap label. Also disables the button. */
  loading?: boolean;
  /** Text shown while loading. Falls back to label if omitted. */
  loadingLabel?: string;
  /** Icon rendered before the label (hidden during loading). */
  icon?: React.ReactNode;
  /** HTML button type. Defaults to 'button'. Use 'submit' for form buttons. */
  type?: 'button' | 'submit';
  /** data-testid for the button. */
  testId?: string;
}

export interface ModalActionsProps {
  /** Primary action button (rightmost in two-button mode, full-width in single mode). */
  primary: ModalActionButton;
  /** Cancel/secondary button. Omit for single-button mode. */
  cancel?: ModalActionButton;
  /** Additional CSS classes on the container. */
  className?: string;
}

function renderButton(
  config: ModalActionButton,
  sizeClass: string,
  defaultVariant: 'default' | 'outline'
): React.JSX.Element {
  const variant = config.variant ?? defaultVariant;
  const isDisabled = config.disabled === true || config.loading === true;
  const isLoading = config.loading === true;
  const displayLabel = isLoading ? (config.loadingLabel ?? config.label) : config.label;

  return (
    <Button
      variant={variant}
      className={sizeClass}
      onClick={config.onClick}
      disabled={isDisabled}
      type={config.type ?? 'button'}
      {...(config.testId !== undefined && { 'data-testid': config.testId })}
    >
      {isLoading ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {displayLabel}
        </>
      ) : (
        <>
          {config.icon !== undefined && config.icon}
          {config.label}
        </>
      )}
    </Button>
  );
}

export function ModalActions({
  primary,
  cancel,
  className,
}: Readonly<ModalActionsProps>): React.JSX.Element {
  if (cancel === undefined) {
    return renderButton(primary, cn('w-full', className), 'default');
  }

  return (
    <div className={cn('flex gap-2', className)}>
      {renderButton(cancel, 'flex-1', 'outline')}
      {renderButton(primary, 'flex-1', 'default')}
    </div>
  );
}
