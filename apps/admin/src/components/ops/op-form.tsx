import * as React from 'react';
import { Button, IconButton } from '@hushbox/ui';
import { OverlayFooter } from '@hushbox/ui/overlay';
import {
  FieldMessage,
  InlineInput,
  LABELLED_FIELD_CLASSES,
  SelectField,
  SwitchField,
  TextField,
} from '@hushbox/ui/field';
import { ChevronDown, ChevronUp, Minus, Plus } from '@hushbox/ui/icons';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import {
  buildOpInput,
  groupErrorKey,
  groupRows,
  isGroupRowEmpty,
  remapGroupRowErrors,
} from '@/lib/op-fields';
import type {
  OpFieldDescriptor,
  OpFieldValue,
  OpFormValues,
  OpGroupRowValue,
} from '@/lib/op-fields';

interface OpFormProps {
  readonly fields: readonly OpFieldDescriptor[];
  readonly initialValues?: Readonly<OpFormValues>;
  readonly onSubmit: (input: Record<string, unknown>) => void;
  readonly pending?: boolean;
  readonly formRef?: React.Ref<HTMLFormElement>;
}

/** Narrows a stored form value to what a scalar widget can hold. */
function scalarValue(value: OpFieldValue | undefined): string | boolean | undefined {
  return typeof value === 'object' ? undefined : value;
}

/** The ids that describe a control, or none when nothing does. */
function describedByOf(ids: readonly (string | undefined)[]): string | undefined {
  const present = ids.filter((id) => id !== undefined);
  return present.length === 0 ? undefined : present.join(' ');
}

/** The id of a control's optionality marker, referenced by aria-describedby. */
function optionalHintId(controlId: string): string {
  return `${controlId}-optional`;
}

/**
 * The optionality the contract declares, marked in words rather than colour or
 * a bare glyph, because an operator who assumes every box must be filled does
 * the wrong thing on the ops where a blank box is the safe answer.
 */
const OPTIONAL_MARKER = 'optional';

/** A group's name with its optionality; a group labels a container, not a control. */
function GroupLabel({
  field,
  groupId,
}: Readonly<{ field: OpFieldDescriptor; groupId: string }>): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span className={LABELLED_FIELD_CLASSES.label}>{field.name}</span>
      {field.required ? null : (
        <span id={optionalHintId(groupId)} className="text-muted-foreground text-xs">
          {OPTIONAL_MARKER}
        </span>
      )}
    </div>
  );
}

interface ScalarControlProps {
  readonly field: OpFieldDescriptor;
  readonly id: string;
  readonly value: string | boolean | undefined;
  readonly error: string | undefined;
  readonly onChange: (value: string | boolean) => void;
}

/** The error a shared field takes, spread only when there is one. */
function errorProps(error: string | undefined): { error?: string } {
  return error === undefined ? {} : { error };
}

function ChoiceControl({
  field,
  id,
  value,
  error,
  onChange,
}: ScalarControlProps): React.JSX.Element {
  return (
    <SelectField<string>
      id={id}
      label={field.name}
      value={typeof value === 'string' ? value : ''}
      placeholder="Select a value"
      options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
      onValueChange={onChange}
      {...(field.required ? {} : { help: OPTIONAL_MARKER })}
      {...errorProps(error)}
      errorTestId={TEST_IDS.adminOpFieldError}
    />
  );
}

function BooleanControl({
  field,
  id,
  value,
  error,
  onChange,
}: ScalarControlProps): React.JSX.Element {
  return (
    <SwitchField
      id={id}
      testId={TEST_ID_BUILDERS.adminOpBooleanToggle(field.name)}
      label={field.name}
      checked={value === true}
      onCheckedChange={onChange}
      {...(field.required ? {} : { description: OPTIONAL_MARKER })}
      {...errorProps(error)}
      errorTestId={TEST_IDS.adminOpFieldError}
    />
  );
}

type TextInputProps = Required<
  Pick<
    React.ComponentProps<'input'>,
    'id' | 'name' | 'type' | 'autoComplete' | 'value' | 'onChange'
  >
>;

/** The native input props every text control shares, scalar or in a group row. */
function textInputProps({
  field,
  id,
  value,
  onChange,
}: Omit<ScalarControlProps, 'error'>): TextInputProps {
  return {
    id,
    name: field.name,
    type: field.control === 'number' ? 'number' : 'text',
    autoComplete: 'off',
    value: typeof value === 'string' ? value : '',
    onChange: (event) => {
      onChange(event.target.value);
    },
  };
}

function TextControl({ field, id, value, error, onChange }: ScalarControlProps): React.JSX.Element {
  return (
    <div className={LABELLED_FIELD_CLASSES.control}>
      <TextField
        {...textInputProps({ field, id, value, onChange })}
        label={field.name}
        {...(field.required ? {} : { 'aria-describedby': optionalHintId(id) })}
        {...errorProps(error)}
        errorTestId={TEST_IDS.adminOpFieldError}
      />
      {field.required ? null : (
        <p id={optionalHintId(id)} className="text-muted-foreground mt-1 text-xs">
          {OPTIONAL_MARKER}
        </p>
      )}
    </div>
  );
}

/**
 * A text control inside a group row, where a floating label's taller box would not line up
 * with the choice trigger beside it: the label sits above a plain input of the trigger's
 * height, in the labelled-field frame `SelectField` draws itself with.
 */
function RowTextControl({
  field,
  id,
  value,
  error,
  onChange,
}: ScalarControlProps): React.JSX.Element {
  const labelId = `${id}-label`;
  const messageId = `${id}-message`;
  const describedBy = describedByOf([
    field.required ? undefined : optionalHintId(id),
    error === undefined ? undefined : messageId,
  ]);
  return (
    <div className={LABELLED_FIELD_CLASSES.stack}>
      <label id={labelId} htmlFor={id} className={LABELLED_FIELD_CLASSES.label}>
        {field.name}
      </label>
      <div className={LABELLED_FIELD_CLASSES.control}>
        <InlineInput
          {...textInputProps({ field, id, value, onChange })}
          aria-labelledby={labelId}
          {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
          {...(error === undefined ? {} : { 'aria-invalid': true })}
        />
        {field.required ? null : (
          <p id={optionalHintId(id)} className={LABELLED_FIELD_CLASSES.help}>
            {OPTIONAL_MARKER}
          </p>
        )}
        <FieldMessage id={messageId} error={error} errorTestId={TEST_IDS.adminOpFieldError} />
      </div>
    </div>
  );
}

/** One shared field per scalar control kind; a group row draws its text controls in-row. */
function ScalarControl(
  props: ScalarControlProps & { readonly inRow?: boolean }
): React.JSX.Element {
  const { inRow = false, ...control } = props;
  if (control.field.control === 'enum') {
    return <ChoiceControl {...control} />;
  }
  if (control.field.control === 'boolean') {
    return <BooleanControl {...control} />;
  }
  return inRow ? <RowTextControl {...control} /> : <TextControl {...control} />;
}

interface GroupFieldProps {
  readonly field: OpFieldDescriptor;
  readonly value: OpFieldValue | undefined;
  readonly errors: Readonly<Record<string, string>>;
  readonly onChange: (
    rows: readonly OpGroupRowValue[],
    mapRowIndex?: (rowIndex: number) => number | undefined
  ) => void;
}

/**
 * Repeatable group rows with exactly one trailing empty row: typing into it
 * grows the list, and only non-trailing rows are deletable, reorderable, or
 * displaced by a prepend. Fully empty rows are dropped at submit by
 * `buildOpInput`. Reorders, prepends, and deletes pass an index mapping so
 * the form can remap displayed row errors to follow their rows (a deleted
 * row maps to `undefined`, dropping its errors).
 */
function GroupField({ field, value, errors, onChange }: GroupFieldProps): React.JSX.Element {
  const groupId = `op-field-${field.name}`;
  const stored = groupRows(value);
  const last = stored.at(-1);
  const rows: readonly OpGroupRowValue[] =
    last !== undefined && isGroupRowEmpty(field, last) ? stored : [...stored, {}];

  // Set by prepend so the render carrying the new empty row moves focus into
  // its first control; cleared before focusing so it fires exactly once.
  const focusFirstRowRef = React.useRef(false);
  React.useEffect(() => {
    if (focusFirstRowRef.current) {
      focusFirstRowRef.current = false;
      const firstSub = (field.fields ?? [])[0];
      if (firstSub !== undefined) {
        document
          .querySelector<HTMLElement>(`[id="op-field-${field.name}-0-${firstSub.name}"]`)
          ?.focus();
      }
    }
  });

  function setRowValue(index: number, subName: string, subValue: string | boolean): void {
    onChange(
      rows.map((row, rowIndex) => (rowIndex === index ? { ...row, [subName]: subValue } : row))
    );
  }

  function removeRow(index: number): void {
    onChange(
      rows.filter((_, rowIndex) => rowIndex !== index),
      (rowIndex) => {
        if (rowIndex === index) {
          return; // The deleted row's errors die with it.
        }
        return rowIndex > index ? rowIndex - 1 : rowIndex;
      }
    );
  }

  /** Swaps the adjacent full rows at `first` and `first + 1` (slice-built to
   * keep the swap total under noUncheckedIndexedAccess — no index fallbacks). */
  function swapAdjacentRows(first: number): void {
    const second = first + 1;
    const reordered = [
      ...rows.slice(0, first),
      ...rows.slice(second, second + 1),
      ...rows.slice(first, second),
      ...rows.slice(second + 1),
    ];
    onChange(reordered, (rowIndex) => {
      if (rowIndex === first) {
        return second;
      }
      if (rowIndex === second) {
        return first;
      }
      return rowIndex;
    });
  }

  function prependRow(): void {
    focusFirstRowRef.current = true;
    onChange([{}, ...rows], (rowIndex) => rowIndex + 1);
  }

  return (
    <div
      data-testid={TEST_ID_BUILDERS.adminOpGroup(field.name)}
      className="flex flex-col gap-2"
      role="group"
      aria-label={field.name}
      aria-describedby={describedByOf([
        field.required ? undefined : optionalHintId(groupId),
        errors[field.name] === undefined ? undefined : `${groupId}-message`,
      ])}
    >
      <GroupLabel field={field} groupId={groupId} />
      <div>
        <IconButton
          type="button"
          data-testid={TEST_ID_BUILDERS.adminOpGroupPrepend(field.name)}
          aria-label={`Add ${field.name} row at the front`}
          onClick={() => {
            prependRow();
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {rows.map((row, index) => {
        const isTrailingEmptyRow = index === rows.length - 1;
        return (
          <div
            // Rows have no stable identity beyond position; index keys are
            // safe because edits and deletes rebuild the whole list.
            key={index}
            data-testid={TEST_ID_BUILDERS.adminOpGroupRow(field.name, index)}
            className="border-border flex items-start gap-2 rounded-md border p-2"
          >
            <div className="flex grow flex-wrap gap-2">
              {(field.fields ?? []).map((sub) => {
                const id = `op-field-${field.name}-${String(index)}-${sub.name}`;
                return (
                  <div key={sub.name} className="min-w-32 grow">
                    <ScalarControl
                      inRow
                      field={sub}
                      id={id}
                      value={row[sub.name]}
                      error={errors[groupErrorKey(field.name, index, sub.name)]}
                      onChange={(subValue) => {
                        setRowValue(index, sub.name, subValue);
                      }}
                    />
                  </div>
                );
              })}
            </div>
            {isTrailingEmptyRow ? null : (
              // Compact vertical action cluster: delete on top, then the
              // stacked up/down move pair — narrower than a horizontal row.
              <div className="flex flex-col gap-1">
                <IconButton
                  type="button"
                  data-testid={TEST_ID_BUILDERS.adminOpGroupRowDelete(field.name, index)}
                  aria-label={`Remove ${field.name} row ${String(index + 1)}`}
                  onClick={() => {
                    removeRow(index);
                  }}
                >
                  <Minus className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  type="button"
                  data-testid={TEST_ID_BUILDERS.adminOpGroupRowMoveUp(field.name, index)}
                  aria-label={`Move ${field.name} row ${String(index + 1)} up`}
                  disabled={index === 0}
                  onClick={() => {
                    swapAdjacentRows(index - 1);
                  }}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  type="button"
                  data-testid={TEST_ID_BUILDERS.adminOpGroupRowMoveDown(field.name, index)}
                  aria-label={`Move ${field.name} row ${String(index + 1)} down`}
                  // The trailing empty row is always last, so the last filled
                  // row sits just above it and must never swap into that slot.
                  disabled={index === rows.length - 2}
                  onClick={() => {
                    swapAdjacentRows(index);
                  }}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </IconButton>
              </div>
            )}
          </div>
        );
      })}
      {/* Drawn only with an error: an empty row here would still take the container's gap. */}
      {errors[field.name] === undefined ? null : (
        <FieldMessage
          id={`${groupId}-message`}
          error={errors[field.name]}
          errorTestId={TEST_IDS.adminOpFieldError}
        />
      )}
    </div>
  );
}

/**
 * The one generic op form: rendered entirely from contract-derived field
 * descriptors. A field this form cannot render is a contract bug (inputs
 * must stay flat, repeatable groups aside), never a reason for a bespoke
 * per-op form.
 */
export function OpForm({
  fields,
  initialValues,
  onSubmit,
  pending,
  formRef,
}: OpFormProps): React.JSX.Element {
  const [values, setValues] = React.useState<OpFormValues>(() => ({
    ...initialValues,
  }));
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  function setValue(name: string, value: OpFieldValue): void {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    const built = buildOpInput(fields, values);
    setErrors(built.errors);
    if (Object.keys(built.errors).length === 0) {
      onSubmit(built.input);
    }
  }

  return (
    <form
      ref={formRef}
      data-testid={TEST_IDS.adminOpForm}
      noValidate
      onSubmit={handleSubmit}
      className="flex flex-col gap-3"
    >
      {fields.map((field) =>
        field.control === 'group' ? (
          <GroupField
            key={field.name}
            field={field}
            value={values[field.name]}
            errors={errors}
            onChange={(rows, mapRowIndex) => {
              setValue(field.name, rows);
              // Remap rather than clear: submit-time row errors keep pointing
              // at the row that produced them across reorders, prepends, and
              // deletes (a deleted row's errors are dropped).
              if (mapRowIndex !== undefined) {
                setErrors((current) => remapGroupRowErrors(current, field.name, mapRowIndex));
              }
            }}
          />
        ) : (
          <ScalarControl
            key={field.name}
            field={field}
            id={`op-field-${field.name}`}
            value={scalarValue(values[field.name])}
            error={errors[field.name]}
            onChange={(value) => {
              setValue(field.name, value);
            }}
          />
        )
      )}
      <OverlayFooter>
        <Button type="submit" disabled={pending === true}>
          Preview changes
        </Button>
      </OverlayFooter>
    </form>
  );
}
