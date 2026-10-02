import { Icon, Shield } from '@hushbox/ui/icons';
import { MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '@hushbox/ui/menu';
import type * as React from 'react';

const CHANGE_PRIVILEGE = 'Change privilege';

interface PrivilegeMenuChoicesProps<P extends string> {
  /** The privileges the viewer may set; with none, the group draws nothing. */
  choices: readonly P[];
  current: string;
  labelTestId: string;
  optionTestId: (privilege: P) => string;
  /** More items follow the group, so a separator closes it. */
  followed: boolean;
  onChoose: (privilege: string) => void;
}

/** A row menu's "Change privilege" group: its label, then one radio item per allowed privilege. */
export function PrivilegeMenuChoices<P extends string>({
  choices,
  current,
  labelTestId,
  optionTestId,
  followed,
  onChoose,
}: Readonly<PrivilegeMenuChoicesProps<P>>): React.JSX.Element | null {
  if (choices.length === 0) return null;
  return (
    <>
      <MenuLabel data-testid={labelTestId}>
        <span className="flex items-center gap-2">
          <Icon icon={Shield} className="text-muted-foreground" />
          {CHANGE_PRIVILEGE}
        </span>
      </MenuLabel>
      <MenuRadioGroup value={current} label={CHANGE_PRIVILEGE} onValueChange={onChoose}>
        {choices.map((privilege) => (
          <MenuRadioItem
            key={privilege}
            value={privilege}
            title={privilege}
            data-testid={optionTestId(privilege)}
          />
        ))}
      </MenuRadioGroup>
      {followed && <MenuSeparator />}
    </>
  );
}
