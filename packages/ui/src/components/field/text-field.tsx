import * as React from 'react';

import { cn } from '../../lib/utilities';
import { Icon } from '../icons/icon';
import { FieldMessage } from './field-message';

interface TextFieldExtras {
  icon?: React.ComponentType<{ className?: string }>;
  suffix?: React.ReactNode;
  error?: string;
  success?: string;
  /** Set as the test id on the error line. */
  errorTestId?: string;
}

type TextFieldLabel =
  | { label: string; placeholder?: never }
  | { label?: never; 'aria-label': string; placeholder: string };

type TextFieldProps = TextFieldExtras &
  TextFieldLabel &
  (
    | ({ multiline?: false } & Omit<React.ComponentProps<'input'>, 'placeholder' | 'size'>)
    | ({ multiline: true } & Omit<React.ComponentProps<'textarea'>, 'placeholder'>)
  );

/**
 * The label floats while the input is focused, holds text or is autofilled. It reads
 * the input's own CSS state rather than a React prop, so an uncontrolled input floats
 * it too; the blank placeholder is what makes an empty input visible to that state.
 */
const LABEL_FLOATED_ON_INPUT_STATE =
  'peer-[:is(:focus,:autofill,:not(:placeholder-shown))]:top-2 peer-[:is(:focus,:autofill,:not(:placeholder-shown))]:translate-y-0 peer-[:is(:focus,:autofill,:not(:placeholder-shown))]:text-xs peer-[:is(:focus,:autofill,:not(:placeholder-shown))]:text-primary';

const LABEL_CENTRED = 'top-1/2 -translate-y-1/2 text-sm text-muted-foreground';

const LABEL_FLOATED = 'top-2 text-xs text-primary';

function labelClassName(hasIcon: boolean, multiline: boolean): string {
  return cn(
    'pointer-events-none absolute truncate leading-5 transition-all duration-200 peer-disabled:opacity-50',
    hasIcon ? 'left-10 max-w-[calc(100%-3.25rem)]' : 'left-3 max-w-[calc(100%-1.5rem)]',
    multiline ? LABEL_FLOATED : [LABEL_CENTRED, LABEL_FLOATED_ON_INPUT_STATE],
    multiline && 'leading-4'
  );
}

interface ControlLayout {
  hasLabel: boolean;
  hasIcon: boolean;
  hasSuffix: boolean;
  hasError: boolean;
  className: string | undefined;
}

function controlClassName({
  hasLabel,
  hasIcon,
  hasSuffix,
  hasError,
  className,
}: ControlLayout): string {
  return cn(
    // Names its colour properties so the base layer's focus outline appears at once;
    // `transition-colors` would ease `outline-color` in.
    'peer text-foreground block w-full min-w-0 appearance-none rounded-lg border-2 bg-transparent px-3 text-sm transition-[color,background-color,border-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to] duration-150',
    'placeholder:text-transparent disabled:cursor-not-allowed disabled:opacity-50',
    hasLabel ? 'pt-6 pb-2' : 'placeholder:text-muted-foreground py-3',
    hasIcon && 'pl-10',
    hasSuffix && 'pr-11',
    hasError ? 'border-destructive' : 'border-border-control focus:border-primary',
    className
  );
}

function describedBy(
  callerIds: string | undefined,
  messageId: string | undefined
): string | undefined {
  const ids = [callerIds, messageId].filter(Boolean).join(' ');
  return ids === '' ? undefined : ids;
}

interface FieldFrameProps {
  id: string;
  multiline: boolean;
  icon: TextFieldExtras['icon'];
  suffix: React.ReactNode;
  error: string | undefined;
  success: string | undefined;
  label: string | undefined;
  errorTestId?: string | undefined;
}

interface NativeControlProps {
  placeholder?: string | undefined;
  className?: string | undefined;
  'aria-invalid'?: React.AriaAttributes['aria-invalid'];
  'aria-describedby'?: string | undefined;
}

/** The props the field sets on its control, over whatever the caller passed. */
function controlProps(
  frame: FieldFrameProps,
  native: NativeControlProps
): NativeControlProps & { id: string } {
  const hasError = Boolean(frame.error);
  const hasMessage = Boolean(frame.error) || Boolean(frame.success);
  return {
    id: frame.id,
    placeholder: frame.label === undefined ? native.placeholder : ' ',
    'aria-invalid': hasError ? true : native['aria-invalid'],
    'aria-describedby': describedBy(
      native['aria-describedby'],
      hasMessage ? `${frame.id}-message` : undefined
    ),
    className: controlClassName({
      hasLabel: frame.label !== undefined,
      hasIcon: frame.icon !== undefined,
      hasSuffix: frame.suffix !== undefined,
      hasError,
      className: native.className,
    }),
  };
}

function FieldFrame({
  id,
  multiline,
  icon,
  suffix,
  error,
  success,
  label,
  errorTestId,
  children,
}: Readonly<FieldFrameProps & { children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="relative min-w-0">
        {children}
        {label !== undefined && (
          <label htmlFor={id} className={labelClassName(icon !== undefined, multiline)}>
            {label}
          </label>
        )}
        {icon !== undefined && (
          <Icon
            icon={icon}
            size="lg"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
          />
        )}
        {suffix !== undefined && (
          <div className="text-foreground/50 absolute top-1/2 right-3 inline-flex -translate-y-1/2 items-center">
            {suffix}
          </div>
        )}
      </div>
      <FieldMessage
        id={`${id}-message`}
        error={error}
        success={success}
        errorTestId={errorTestId}
        reserve
      />
    </div>
  );
}

/**
 * The short text field: a floating label inside a bordered box, an optional leading
 * icon and trailing suffix, and a message row under it that holds a field error or a
 * success line. `multiline` draws the message-box form, a textarea whose label always
 * sits floated. Every native prop reaches the control.
 */
function TextField(props: Readonly<TextFieldProps>): React.JSX.Element {
  const generatedId = React.useId();
  if (props.multiline === true) {
    const { multiline, icon, suffix, error, success, label, errorTestId, ...native } = props;
    const frame = { id: native.id ?? generatedId, multiline, icon, suffix, error, success, label };
    return (
      <FieldFrame {...frame} errorTestId={errorTestId}>
        <textarea {...native} {...controlProps(frame, native)} />
      </FieldFrame>
    );
  }
  const { multiline = false, icon, suffix, error, success, label, errorTestId, ...native } = props;
  const frame = { id: native.id ?? generatedId, multiline, icon, suffix, error, success, label };
  return (
    <FieldFrame {...frame} errorTestId={errorTestId}>
      <input {...native} {...controlProps(frame, native)} />
    </FieldFrame>
  );
}

export { TextField };
export type { TextFieldProps };
