import * as React from 'react';
import { cn } from '@hushbox/ui';
import { SwitchField } from '@hushbox/ui/field';
import { ChevronRight, ExternalLink, Icon } from '@hushbox/ui/icons';

type SettingsRowKind =
  | {
      kind: 'navigate';
      onClick: () => void;
      badge?: React.ReactNode;
      ref?: React.Ref<HTMLButtonElement>;
    }
  | {
      kind: 'toggle';
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
      disabled?: boolean;
      switchTestId?: string;
    }
  | { kind: 'link'; onOpen: () => void; external?: boolean }
  | { kind: 'value'; value: React.ReactNode }
  | { kind: 'action'; action: React.ReactElement; inline?: boolean; icon?: React.ReactNode };

export type SettingsRowProps = {
  title?: string;
  description?: React.ReactNode;
  testId?: string;
} & SettingsRowKind;

const ROW_CLASS = 'relative isolate flex w-full items-center gap-4 py-2.5 text-left';

// The hover wash reaches half a rem past the row's edges, as the rows' text sits flush with the list rules.
const PRESSABLE_CLASS =
  'cursor-pointer before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-md before:transition-colors before:duration-150 hover:before:bg-accent';

// An inline action is 7rem in a list 40rem or narrower and 12rem in a wider one: `100cqw`
// is the list's width, and the clamp is 0 up to the full-width limit and 5rem past it.
const ACTION_CELL_CLASS = 'flex flex-[1_0_100%]';
const INLINE_ACTION_CELL_CLASS =
  'md:flex-none md:[&>*]:w-[calc(7rem_+_clamp(0rem,(100cqw_-_var(--btn-full-max))_*_1e5,5rem))]! md:[&>*]:max-w-none! md:[&>*]:mx-0!';

interface TextBlockIds {
  titleId: string;
  descriptionId: string;
}

function rowHeightClass(description: React.ReactNode): string {
  return description === undefined ? 'min-h-14' : 'min-h-16';
}

function TextBlock({
  title,
  description,
  ids,
  className,
}: Readonly<{
  title: string | undefined;
  description: React.ReactNode;
  ids: TextBlockIds;
  className?: string;
}>): React.JSX.Element {
  return (
    <span className={cn('flex min-w-0 flex-auto flex-col gap-0.5', className)}>
      {title === undefined ? null : (
        <span
          id={ids.titleId}
          data-settings-title=""
          className="text-ui text-foreground font-medium"
        >
          {title}
        </span>
      )}
      {description === undefined ? null : (
        <span id={ids.descriptionId} className="text-ui-sm text-muted-foreground">
          {description}
        </span>
      )}
    </span>
  );
}

function Trailing({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <span
      data-settings-trailing=""
      className="text-ui-sm text-muted-foreground flex flex-none items-center gap-1.5"
    >
      {children}
    </span>
  );
}

function describedBy(ids: readonly (string | false)[]): { 'aria-describedby'?: string } {
  const present = ids.filter((id) => id !== false);
  return present.length === 0 ? {} : { 'aria-describedby': present.join(' ') };
}

/** What every kind shares: the ids, the row's class and its test id. */
interface RowFrame {
  title: string | undefined;
  description: React.ReactNode;
  ids: TextBlockIds;
  badgeId: string;
  rowClass: string;
  testIdProps: { 'data-testid'?: string };
  labelledBy: { 'aria-labelledby'?: string };
}

type KindProps<K extends SettingsRowKind['kind']> = Extract<SettingsRowKind, { kind: K }>;

function NavigateRow({
  frame,
  row,
  buttonRef,
}: Readonly<{
  frame: RowFrame;
  row: Omit<KindProps<'navigate'>, 'ref'>;
  buttonRef: React.Ref<HTMLButtonElement> | undefined;
}>): React.JSX.Element {
  return (
    <button
      ref={buttonRef}
      type="button"
      data-settings-row=""
      {...frame.testIdProps}
      {...frame.labelledBy}
      {...describedBy([
        frame.description !== undefined && frame.ids.descriptionId,
        row.badge !== undefined && frame.badgeId,
      ])}
      onClick={row.onClick}
      className={cn(frame.rowClass, PRESSABLE_CLASS)}
    >
      <TextBlock title={frame.title} description={frame.description} ids={frame.ids} />
      <Trailing>
        {row.badge === undefined ? null : <span id={frame.badgeId}>{row.badge}</span>}
        <Icon icon={ChevronRight} />
      </Trailing>
    </button>
  );
}

// A button with the link role: it opens a page through the caller, which may leave the
// app's webview, so it has no href of its own.
function LinkRow({
  frame,
  row,
}: Readonly<{ frame: RowFrame; row: KindProps<'link'> }>): React.JSX.Element {
  return (
    <button
      type="button"
      role="link"
      data-settings-row=""
      {...frame.testIdProps}
      {...frame.labelledBy}
      {...describedBy([frame.description !== undefined && frame.ids.descriptionId])}
      onClick={row.onOpen}
      className={cn(frame.rowClass, PRESSABLE_CLASS)}
    >
      <TextBlock title={frame.title} description={frame.description} ids={frame.ids} />
      {row.external === true ? (
        <Trailing>
          <Icon icon={ExternalLink} />
        </Trailing>
      ) : null}
    </button>
  );
}

function ToggleRow({
  frame,
  row,
}: Readonly<{ frame: RowFrame; row: KindProps<'toggle'> }>): React.JSX.Element {
  return (
    <div data-settings-row="" {...frame.testIdProps} className={frame.rowClass}>
      <div className="min-w-0 flex-auto">
        <SwitchField
          checked={row.checked}
          onCheckedChange={row.onCheckedChange}
          label={frame.title}
          settingsRow
          {...(frame.description !== undefined && { description: frame.description })}
          {...(row.disabled !== undefined && { disabled: row.disabled })}
          {...(row.switchTestId !== undefined && { testId: row.switchTestId })}
        />
      </div>
    </div>
  );
}

function ValueRow({
  frame,
  row,
}: Readonly<{ frame: RowFrame; row: KindProps<'value'> }>): React.JSX.Element {
  return (
    <div data-settings-row="" {...frame.testIdProps} className={frame.rowClass}>
      <TextBlock title={frame.title} description={frame.description} ids={frame.ids} />
      <Trailing>{row.value}</Trailing>
    </div>
  );
}

function ActionRow({
  frame,
  row,
}: Readonly<{ frame: RowFrame; row: KindProps<'action'> }>): React.JSX.Element {
  const inline = row.inline === true;
  return (
    <div
      data-settings-row=""
      {...frame.testIdProps}
      className={cn(frame.rowClass, 'flex-wrap gap-y-3', inline && 'md:flex-nowrap')}
    >
      {row.icon === undefined ? null : <span className="flex flex-none">{row.icon}</span>}
      <TextBlock
        title={frame.title}
        description={frame.description}
        ids={frame.ids}
        className={cn('flex-[1_1_0]', inline && 'md:text-pretty')}
      />
      <div className={cn(ACTION_CELL_CLASS, inline && INLINE_ACTION_CELL_CLASS)}>{row.action}</div>
    </div>
  );
}

/** One settings row; its kind decides the control, and every kind shares the text block. */
export function SettingsRow(props: Readonly<SettingsRowProps>): React.JSX.Element {
  const { title, description, testId } = props;
  const baseId = React.useId();
  const frame: RowFrame = {
    title,
    description,
    ids: { titleId: `${baseId}-title`, descriptionId: `${baseId}-description` },
    badgeId: `${baseId}-badge`,
    rowClass: cn(ROW_CLASS, rowHeightClass(description)),
    testIdProps: testId === undefined ? {} : { 'data-testid': testId },
    labelledBy: title === undefined ? {} : { 'aria-labelledby': `${baseId}-title` },
  };

  switch (props.kind) {
    case 'navigate': {
      const { ref, ...row } = props;
      return <NavigateRow frame={frame} row={row} buttonRef={ref} />;
    }
    case 'link': {
      return <LinkRow frame={frame} row={props} />;
    }
    case 'toggle': {
      return <ToggleRow frame={frame} row={props} />;
    }
    case 'value': {
      return <ValueRow frame={frame} row={props} />;
    }
    case 'action': {
      return <ActionRow frame={frame} row={props} />;
    }
  }
}
