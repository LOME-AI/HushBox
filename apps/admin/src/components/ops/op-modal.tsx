import * as React from 'react';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, IconButton, useCopyToClipboard } from '@hushbox/ui';
import { Overlay, OverlayContent, OverlayFooter, OverlayHeader } from '@hushbox/ui/overlay';
import { Notice } from '@hushbox/ui/notice';
import { CircleAlert, Copy } from '@hushbox/ui/icons';
import { TEST_IDS, asErrorCode, friendlyErrorMessage } from '@hushbox/shared';
import { ApiError } from '@/lib/api-client';
import { describeOpFields, toFormValues } from '@/lib/op-fields';
import { executeOp, previewOp, withoutReason } from '@/lib/op-run';
import { DiffList } from './diff-list.js';
import { OpForm } from './op-form.js';
import type { AdminOpExecuteResult, AdminOpPreviewResult, AdminOpWire } from '@hushbox/shared';
import type { OpFormValues } from '@/lib/op-fields';

/** Every admin read's query key is rooted here (dashboard, jobs, models,
 * customer-360, audit, ops catalog — see the hooks' key factories). */
const ADMIN_QUERY_KEY_ROOT = ['admin'] as const;

/** Where an OpModal flow starts: the op plus optional prefill/undo linkage. */
export interface OpFlowStart {
  readonly opName: string;
  readonly initialValues?: Readonly<OpFormValues>;
  /** Audit row id this flow undoes (set when the flow runs an inverse op). */
  readonly undoes?: string;
}

interface OpModalProps {
  readonly ops: readonly AdminOpWire[];
  readonly start: OpFlowStart;
  readonly onClose: () => void;
}

type Step = 'form' | 'preview' | 'result';

function ErrorNotice({ error }: Readonly<{ error: unknown }>): React.JSX.Element {
  const code = error instanceof ApiError ? error.message : 'INTERNAL';
  return (
    <Notice tone="error" icon={CircleAlert} destructive data-testid={TEST_IDS.adminOpError}>
      {friendlyErrorMessage(asErrorCode(code))} <span className="font-mono text-xs">{code}</span>
    </Notice>
  );
}

/** A control a keyboard reaches: hidden form mirrors (Radix's native select and switch input) sit at -1. */
const TABBABLE =
  ':is(input, select, textarea, button, [tabindex]):not([disabled], [tabindex="-1"], [type="hidden"])';

/** The execute button states the previewed consequence, never "Confirm". */
function executeLabelFor(title: string, data: AdminOpPreviewResult | undefined): string {
  const count = data?.effects.length ?? 0;
  return `${title} (${String(count)} ${count === 1 ? 'change' : 'changes'})`;
}

/** The inverse flow Undo starts, or null when the op has nothing to undo. */
function undoFlowFor(
  contract: AdminOpWire | undefined,
  result: AdminOpExecuteResult
): OpFlowStart | null {
  if (contract?.inverse == null || result.inverseInput === null) {
    return null;
  }
  return {
    opName: contract.inverse,
    initialValues: toFormValues(result.inverseInput),
    undoes: result.auditId,
  };
}

/**
 * A `system-owned` op leaves a durable effect and registers no inverse, and
 * the contract's stated reason is the only gate on claiming the class. Rendered
 * here — at the top of the run flow, before the form is even submitted — so
 * the case for a no-undo effect reaches the operator who runs it, not only
 * the reviewer who read the contract when it was written.
 */
function SystemOwnedNotice({
  contract,
}: Readonly<{ contract: AdminOpWire | undefined }>): React.JSX.Element | null {
  const reason = contract?.systemOwnedReason;
  if (reason === undefined) {
    return null;
  }
  return (
    <p className="text-muted-foreground text-xs">
      No undo. The effect is the system&apos;s own, not the operator&apos;s: {reason}
    </p>
  );
}

interface PreviewStepProps {
  readonly pending: boolean;
  readonly error: unknown;
  readonly data: AdminOpPreviewResult | undefined;
  readonly executeLabel: string;
  readonly executePending: boolean;
  readonly onBack: () => void;
  readonly onExecute: () => void;
}

function PreviewStep(props: Readonly<PreviewStepProps>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {props.pending ? <p className="text-muted-foreground text-sm">Previewing changes…</p> : null}
      {props.error == null ? null : <ErrorNotice error={props.error} />}
      {props.data === undefined ? null : <DiffList effects={props.data.effects} />}
      <OverlayFooter>
        <Button variant="outline" onClick={props.onBack} disabled={props.executePending}>
          Back to form
        </Button>
        {props.data === undefined ? null : (
          <Button
            data-testid={TEST_IDS.adminOpExecute}
            // The label names the op and its change count, so it can outgrow half the row.
            block
            onClick={props.onExecute}
            disabled={props.executePending}
          >
            {props.executeLabel}
          </Button>
        )}
      </OverlayFooter>
    </div>
  );
}

interface ResultStepProps {
  readonly result: AdminOpExecuteResult;
  readonly undoFlow: OpFlowStart | null;
  readonly onUndo: (flow: OpFlowStart) => void;
  readonly onClose: () => void;
}

function ResultStep({ result, undoFlow, onUndo, onClose }: ResultStepProps): React.JSX.Element {
  const { copy } = useCopyToClipboard();

  return (
    <div data-testid={TEST_IDS.adminOpResult} className="flex flex-col gap-3">
      <p className="text-sm">Executed. Audit row:</p>
      <p className="flex items-center gap-1">
        <span data-testid={TEST_IDS.adminOpAuditId} className="font-mono text-xs break-all">
          {result.auditId}
        </span>
        <IconButton
          data-testid={TEST_IDS.adminOpCopyAudit}
          aria-label="Copy audit row id"
          onClick={() => {
            void copy(result.auditId);
          }}
        >
          <Copy className="h-3.5 w-3.5" />
        </IconButton>
      </p>
      <OverlayFooter>
        {undoFlow === null ? null : (
          <Button
            data-testid={TEST_IDS.adminOpUndo}
            variant="outline"
            onClick={() => {
              onUndo(undoFlow);
            }}
          >
            Undo
          </Button>
        )}
        <Button onClick={onClose}>Done</Button>
      </OverlayFooter>
    </div>
  );
}

/**
 * The app's one interaction signature: form, preview diff, execute/result
 * with Undo. Every mutation flows through this modal; there are no bespoke
 * confirm dialogs. The Idempotency-Key is minted once per form submission
 * and reused across retries of that submission.
 */
export function OpModal({ ops, start, onClose }: OpModalProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [flow, setFlow] = React.useState<OpFlowStart>(start);
  const [step, setStep] = React.useState<Step>('form');
  const [input, setInput] = React.useState<Record<string, unknown>>({});
  // Raw form values survive a Back-to-form round trip after a blocked preview.
  const [formValues, setFormValues] = React.useState<OpFormValues>(() =>
    withoutReason({ ...start.initialValues })
  );
  const idempotencyKey = React.useRef<string>('');
  // The overlay draws its close button before its content, so its own first-tabbable
  // default lands there; the operator's first keystroke belongs in the first field. The form
  // commits before the overlay's open-focus effect runs, so the record is ready for it.
  const firstControl = React.useRef<HTMLElement | null>(null);
  const recordFirstControl = React.useCallback((form: HTMLFormElement | null): void => {
    firstControl.current = form?.querySelector<HTMLElement>(TABBABLE) ?? null;
  }, []);

  const contract = ops.find((op) => op.name === flow.opName);
  const title = contract?.title ?? flow.opName;
  const fields = describeOpFields(flow.opName, contract?.fields ?? []);

  const preview = useMutation<AdminOpPreviewResult, unknown, Record<string, unknown>>({
    mutationFn: (submitted) => previewOp(flow.opName, submitted, flow.undoes),
  });
  // The mutation cache is the one record of an execute in flight. `mutate()` marks it pending
  // before any render, so the close and Back to form handlers read the cache directly to refuse
  // what lands before the pending state renders; the render reads the same record to decide
  // what it offers.
  const executeKey = ['admin-op-execute', React.useId()] as const;
  const executing = useIsMutating({ mutationKey: executeKey }) > 0;
  const executeInFlight = (): boolean => queryClient.isMutating({ mutationKey: executeKey }) > 0;
  const execute = useMutation<AdminOpExecuteResult, unknown>({
    mutationKey: executeKey,
    mutationFn: () =>
      executeOp({
        name: flow.opName,
        input,
        idempotencyKey: idempotencyKey.current,
        ...(flow.undoes === undefined ? {} : { undoes: flow.undoes }),
      }),
  });

  function startFlow(next: OpFlowStart): void {
    setFlow(next);
    setStep('form');
    setInput({});
    setFormValues(withoutReason({ ...next.initialValues }));
    preview.reset();
    execute.reset();
  }

  function handleFormSubmit(submitted: Record<string, unknown>): void {
    // One key per form submission: retries of this submission replay it; a
    // fresh submission (including Undo's inverse flow) mints a new key.
    idempotencyKey.current = crypto.randomUUID();
    setInput(submitted);
    // Deliberately unstripped: the seam strips what seeds a form, and a
    // submission is operator keystrokes, not seed values. Stripping here
    // would erase the operator's typing whenever a blocked preview sends
    // them back to the form.
    setFormValues(toFormValues(submitted));
    setStep('preview');
    preview.mutate(submitted);
  }

  function handleBackToForm(): void {
    if (executeInFlight()) return;
    setStep('form');
    preview.reset();
    execute.reset();
  }

  function handleExecute(): void {
    execute.mutate(undefined, {
      onSuccess: () => {
        // A committed op changed server state somewhere, so every admin read
        // may be stale. Root-level invalidation over per-op key targeting is
        // deliberate: ops compose arbitrary slice effects, so a precise
        // op→key map would drift; refetching the handful of admin reads is
        // cheap and always correct. Undo runs through this same execute
        // path, so it is covered too.
        void queryClient.invalidateQueries({ queryKey: ADMIN_QUERY_KEY_ROOT });
        setStep('result');
      },
    });
  }

  return (
    // Always open while mounted and there is no trigger, so the overlay only ever
    // reports close attempts — onOpenChange(false).
    <Overlay
      open
      onOpenChange={() => {
        if (executeInFlight()) return;
        onClose();
      }}
      ariaLabel={title}
      initialFocus={firstControl}
      // A committed mutation is in flight: closing now would hide its result and its Undo.
      dismissible={!executing}
    >
      <OverlayContent data-testid={TEST_IDS.adminOpModal} size="lg">
        <OverlayHeader
          title={title}
          description={<span className="font-mono text-xs">{flow.opName}</span>}
        />

        <SystemOwnedNotice contract={contract} />

        {step === 'form' ? (
          <OpForm
            fields={fields}
            initialValues={formValues}
            onSubmit={handleFormSubmit}
            pending={preview.isPending}
            formRef={recordFirstControl}
          />
        ) : null}

        {step === 'preview' ? (
          <PreviewStep
            pending={preview.isPending}
            error={preview.error ?? execute.error}
            data={preview.data}
            executeLabel={executeLabelFor(title, preview.data)}
            executePending={executing}
            onBack={handleBackToForm}
            onExecute={handleExecute}
          />
        ) : null}

        {step === 'result' && execute.data !== undefined ? (
          <ResultStep
            result={execute.data}
            undoFlow={undoFlowFor(contract, execute.data)}
            onUndo={startFlow}
            onClose={onClose}
          />
        ) : null}
      </OverlayContent>
    </Overlay>
  );
}
