import * as React from 'react';
import { Search } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { cn, Kbd } from '@hushbox/ui';
import { Button } from '@hushbox/ui/button';
import { InlineInput } from '@hushbox/ui/field';
import { Icon } from '@hushbox/ui/icons';

interface LauncherProps {
  mode: 'launcher';
  onOpen: () => void;
  /** A `useHotkeys` combo, drawn as the row's hint from the desktop band on a fine pointer. */
  kbd?: string | undefined;
  collapsed?: boolean | undefined;
}

interface FieldProps {
  mode: 'field';
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId?: string | undefined;
}

type SidebarSearchRowProps = LauncherProps | FieldProps;

// The quiet row: muted ink that turns to full ink over a faint wash on hover.
const QUIET_LOOK =
  'text-muted-foreground hover:text-foreground hover:bg-foreground/6 dark:hover:bg-foreground/6';

const ROW_TYPE = 'text-ui-sm font-medium';

const EXPANDED = cn(ROW_TYPE, 'w-full justify-start gap-2 px-2.5 has-[>svg]:px-2.5');

const RAIL = 'size-9 justify-center p-0 has-[>svg]:px-0 pointer-coarse:size-11';

function Launcher({ onOpen, kbd, collapsed = false }: Readonly<LauncherProps>): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      // Maestro reads a web view's elements by HTML id, so this one is written literally.
      id="sidebar-search-row"
      data-testid={TEST_IDS.sidebarSearchRow}
      aria-label="Search conversations and actions"
      onClick={onOpen}
      className={cn(QUIET_LOOK, collapsed ? RAIL : EXPANDED)}
    >
      <Icon icon={Search} />
      {!collapsed && <span>Search</span>}
      {!collapsed && kbd !== undefined && <Kbd combo={kbd} form="text" className="ml-auto" />}
    </Button>
  );
}

// The field keeps the launcher's row look; the ring moves from the bare input to the
// whole row, so it circles the icon too. Below the desktop band the input's type stays
// at 16px, which keeps iOS from zooming the page when it takes focus.
function Field({ label, value, onChange, testId }: Readonly<FieldProps>): React.JSX.Element {
  const inputId = React.useId();
  return (
    <label
      htmlFor={inputId}
      className={cn(
        QUIET_LOOK,
        ROW_TYPE,
        'flex h-8 w-full cursor-text items-center gap-2 rounded-md px-2.5 pointer-coarse:h-11',
        'has-[input:focus-visible]:outline-ring has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2'
      )}
    >
      <Icon icon={Search} />
      <InlineInput
        id={inputId}
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="text-foreground md:text-ui-sm h-full min-h-0 flex-1 rounded-none border-0 bg-transparent p-0 text-base shadow-none focus-visible:outline-none dark:bg-transparent pointer-coarse:min-h-0"
        {...(testId === undefined ? {} : { 'data-testid': testId })}
      />
    </label>
  );
}

/**
 * The sidebar's quiet search row. As a launcher it opens whatever `onOpen` opens (the
 * command palette in the sidebar); as a field it filters in place.
 */
export function SidebarSearchRow(props: Readonly<SidebarSearchRowProps>): React.JSX.Element {
  return props.mode === 'launcher' ? <Launcher {...props} /> : <Field {...props} />;
}
