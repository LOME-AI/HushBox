import * as React from 'react';
import { InlineFormError, type UseAsyncActionReturn } from '@hushbox/ui';
import { Button } from '@hushbox/ui/button';
import {
  Overlay,
  OverlayBody,
  OverlayContent,
  OverlayFooter,
  OverlayHeader,
  type OverlayContentProps,
  type OverlayProps,
} from '@hushbox/ui/overlay';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { DevOnly } from './dev-only';
import type { ErrorCode } from '@hushbox/shared';

interface ActionModalPrimaryButton {
  label: string;
  loadingLabel?: string;
  variant?: 'default' | 'destructive' | 'outline';
  disabled?: boolean;
  /**
   * Async work to perform. Runs through `asyncAction.run`; on resolve the
   * modal closes, on reject the inline error region renders and the modal
   * stays open for retry.
   */
  onSubmit: () => Promise<unknown>;
  testId?: string;
  /**
   * HTML button type. Defaults to `'button'`. Set to `'submit'` (with `form`)
   * to wire Enter-key implicit submission to the primary handler — the
   * browser fires `click` on the linked submit button, which routes through
   * `onSubmit`.
   */
  type?: 'button' | 'submit';
  /** `form` attribute — links a `type='submit'` button to a form by id. */
  form?: string;
}

interface ActionModalCancelButton {
  label: string;
  onClick?: () => void;
  testId?: string;
}

interface ActionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Muted text under the title. */
  description?: React.ReactNode;
  /** The flow's position, written above the title. */
  step?: { current: number; total: number };
  /** Hook return value from `useAsyncAction()`. Owns isPending, error, errorKey. */
  asyncAction: UseAsyncActionReturn;
  primary: ActionModalPrimaryButton;
  cancel?: ActionModalCancelButton;
  /**
   * Dev-only failure-simulator buttons. One button per code. Each fires the
   * exact same surface path as a real server-returned failure — no network
   * call. Hidden in CI and production via the `DevOnly` wrapper.
   */
  devSimulateCodes?: readonly ErrorCode[];
  testId: string;
  /** Test id on the title heading itself. */
  titleTestId?: string;
  /** Forwarded to the underlying Overlay — controls auto-focus on open. */
  onOpenAutoFocus?: (event: Event) => void;
  /** Forwarded to the underlying Overlay: the element the dialog focuses when it opens. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  /** Form / input children. Their `onChange` events auto-clear the inline error. */
  children: React.ReactNode;
  /** Size variant. */
  size?: OverlayContentProps['size'];
  /** `alertdialog` announces a dialog that interrupts to confirm or warn. */
  role?: OverlayProps['role'];
}

function DevSimulateButtons({
  codes,
  onSimulate,
}: Readonly<{
  codes: readonly ErrorCode[];
  onSimulate: (code: ErrorCode) => void;
}>): React.JSX.Element | null {
  if (codes.length === 0) return null;
  return (
    <DevOnly>
      <div className="flex flex-col gap-2" data-testid={TEST_IDS.devSimulateFailures}>
        {codes.map((code) => (
          <Button
            key={code}
            type="button"
            variant="outline"
            onClick={() => {
              onSimulate(code);
            }}
            data-testid={TEST_ID_BUILDERS.devSimulate(code)}
            className="w-full"
          >
            Simulate {code}
          </Button>
        ))}
      </div>
    </DevOnly>
  );
}

function CancelButton({
  cancel,
  onClick,
  isPending,
}: Readonly<{
  cancel: ActionModalCancelButton;
  onClick: () => void;
  isPending: boolean;
}>): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      disabled={isPending}
      {...(cancel.testId !== undefined && { 'data-testid': cancel.testId })}
    >
      {cancel.label}
    </Button>
  );
}

function PrimaryButton({
  primary,
  onClick,
  isPending,
}: Readonly<{
  primary: ActionModalPrimaryButton;
  onClick: () => void;
  isPending: boolean;
}>): React.JSX.Element {
  return (
    <Button
      type={primary.type ?? 'button'}
      variant={primary.variant ?? 'default'}
      onClick={onClick}
      disabled={primary.disabled === true || isPending}
      loading={isPending}
      {...(primary.loadingLabel !== undefined && { loadingLabel: primary.loadingLabel })}
      {...(primary.form !== undefined && { form: primary.form })}
      {...(primary.testId !== undefined && { 'data-testid': primary.testId })}
    >
      {primary.label}
    </Button>
  );
}

/**
 * Composite modal for an async user action (add member, remove member, save
 * settings, etc.). Standardises the four properties that every action modal
 * in the app needs and that have historically been re-implemented (or
 * forgotten) per-modal:
 *
 *   1. Loading state on the primary button (spinner + disabled, stable width).
 *   2. Inline error region below the form when the action fails.
 *   3. Dismiss-lock while pending — Escape, backdrop click, mobile swipe-down,
 *      close button all suppressed until the in-flight action settles.
 *   4. Auto-clear-on-input — any keystroke in a child input dismisses the
 *      inline error so the user doesn't read a stale message during retry.
 *
 * The primitive intentionally never falls back to a toast — toasts are the
 * wrong UX for action errors per NN/G (users miss them). Use
 * `useAsyncAction({ fallback: 'toast' })` for non-modal mutations instead.
 */
export function ActionModal({
  open,
  onOpenChange,
  title,
  description,
  step,
  asyncAction,
  primary,
  cancel,
  devSimulateCodes,
  testId,
  titleTestId,
  onOpenAutoFocus,
  initialFocus,
  children,
  size,
  role,
}: Readonly<ActionModalProps>): React.JSX.Element {
  const { isPending, error, errorKey, run, clearError, simulateFailure } = asyncAction;

  const handlePrimary = React.useCallback((): void => {
    void (async (): Promise<void> => {
      const result = await run(primary.onSubmit);
      // Discriminated result: `ok: true` means the action resolved (even if
      // its value was undefined); `ok: false` means it threw and the hook
      // already populated `error` + bumped `errorKey`. Only close on success.
      if (result.ok) {
        onOpenChange(false);
      }
    })();
  }, [run, primary, onOpenChange]);

  const handleCancel = React.useCallback((): void => {
    cancel?.onClick?.();
    onOpenChange(false);
  }, [cancel, onOpenChange]);

  // Auto-clear-on-input: only react when the change/input bubbled up from an
  // actual form control. Catching arbitrary descendant change events would
  // clear errors prematurely if a non-form widget (custom Switch, etc.)
  // bubbles a synthetic `onChange`.
  const handleChange = React.useCallback(
    (event: React.SyntheticEvent): void => {
      if (error === null) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        clearError();
      }
    },
    [error, clearError]
  );

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel={title}
      dismissible={!isPending}
      {...(onOpenAutoFocus !== undefined && { onOpenAutoFocus })}
      {...(initialFocus !== undefined && { initialFocus })}
      {...(role !== undefined && { role })}
    >
      <OverlayContent data-testid={testId} {...(size !== undefined && { size })}>
        <OverlayHeader
          title={title}
          description={description}
          {...(step !== undefined && { step })}
          {...(titleTestId !== undefined && { titleTestId })}
        />

        <OverlayBody>
          {/* Children form region. The `onChange` capture clears stale errors
              without each modal having to wire it manually. */}
          <div onChange={handleChange} onInput={handleChange}>
            {children}
          </div>
        </OverlayBody>

        <InlineFormError error={error} errorKey={errorKey} />

        <OverlayFooter>
          {cancel !== undefined && (
            <CancelButton cancel={cancel} onClick={handleCancel} isPending={isPending} />
          )}
          <PrimaryButton primary={primary} onClick={handlePrimary} isPending={isPending} />
        </OverlayFooter>

        {devSimulateCodes !== undefined && (
          <DevSimulateButtons codes={devSimulateCodes} onSimulate={simulateFailure} />
        )}
      </OverlayContent>
    </Overlay>
  );
}
