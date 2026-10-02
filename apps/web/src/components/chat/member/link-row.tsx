import * as React from 'react';
import { IconButton } from '@hushbox/ui/button';
import { Ellipsis, Icon, Link as LinkIcon, Pencil, Trash2 } from '@hushbox/ui/icons';
import { Menu, MenuItem } from '@hushbox/ui/menu';
import { cn } from '@hushbox/ui';
import { canManageLinks, TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { LINK_PRIVILEGE_OPTIONS } from '@/components/chat/member/member-privilege';
import {
  MoneyColumn,
  ROW_BODY_CLASS,
  ROW_CLASS,
  ROW_MAIN_CLASS,
  ROW_OPTIONS_CLASS,
  ROW_SUB_CLASS,
  privilegeWord,
} from '@/components/chat/member/member-row-parts';
import { PrivilegeMenuChoices } from '@/components/chat/member/privilege-menu-choices';
import { linkLabel } from '@/lib/chat/link-label';
import type { MemberPrivilege } from '@hushbox/shared';
import type { MoneyFigure } from '@/lib/chat/member-money';

interface LinkRowProps {
  link: {
    id: string;
    displayName: string | null;
    privilege: string;
    createdAt: string;
  };
  index: number;
  isCurrentLink: boolean;
  viewerPrivilege: MemberPrivilege;
  /** The link guest's figure; absent or null, the row draws none. */
  money?: MoneyFigure | null;
  onChangeLinkPrivilege?: ((linkId: string, newPrivilege: string) => void) | undefined;
  onSaveLinkName?: ((linkId: string, newName: string) => void) | undefined;
  onRequestRevoke?: ((linkId: string, displayName: string) => void) | undefined;
}

/** The reader's own calendar day of an instant, as `YYYY-MM-DD`. */
function localDay(iso: string): string {
  const at = new Date(iso);
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${String(at.getFullYear())}-${month}-${day}`;
}

export function LinkRow({
  link,
  index,
  isCurrentLink,
  viewerPrivilege,
  money,
  onChangeLinkPrivilege,
  onSaveLinkName,
  onRequestRevoke,
}: Readonly<LinkRowProps>): React.JSX.Element {
  const displayName = linkLabel(link, index);
  // The server gates every link action by link management alone, whatever the link's privilege.
  const mayManage = canManageLinks(viewerPrivilege);
  const [isEditing, setIsEditing] = React.useState(false);
  const [editValue, setEditValue] = React.useState(displayName);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
    }
  }, [isEditing]);

  const handleStartEdit = (): void => {
    setEditValue(displayName);
    setIsEditing(true);
  };

  const handleSave = (): void => {
    if (editValue.trim() !== '') {
      onSaveLinkName?.(link.id, editValue.trim());
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
    }
  };

  return (
    <div
      data-testid={TEST_ID_BUILDERS.linkItem(link.id)}
      data-privilege={link.privilege}
      className={ROW_CLASS}
    >
      <span
        aria-hidden="true"
        data-testid={TEST_IDS.linkIconContainer}
        className="bg-background-subtle text-muted-foreground inline-grid size-8 shrink-0 place-items-center rounded-full"
      >
        <Icon icon={LinkIcon} size="sm" />
      </span>
      <span className={ROW_BODY_CLASS}>
        <span className={ROW_MAIN_CLASS}>
          {isEditing ? (
            <input
              ref={inputRef}
              data-testid={TEST_ID_BUILDERS.linkNameInput(link.id)}
              className="bg-background border-input min-w-0 flex-1 rounded border px-1 py-0.5 text-sm"
              value={editValue}
              onChange={(e) => {
                setEditValue(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              onBlur={handleSave}
            />
          ) : (
            <span
              title={displayName}
              className={cn(
                'text-ui truncate',
                link.displayName === null ? 'text-muted-foreground font-medium' : 'font-semibold'
              )}
            >
              {displayName}
              {isCurrentLink && (
                <span data-testid={TEST_IDS.linkYouBadge} className="ml-1">
                  (you)
                </span>
              )}
            </span>
          )}
          <span className={ROW_SUB_CLASS}>
            {`${privilegeWord(link.privilege)} · created `}
            <span className="whitespace-nowrap">{localDay(link.createdAt)}</span>
          </span>
        </span>
        {money !== undefined && money !== null && <MoneyColumn entityId={link.id} figure={money} />}
      </span>
      {mayManage && !isEditing && (
        <Menu
          title={`Options for ${displayName}`}
          trigger={
            <IconButton
              icon={Ellipsis}
              size="sm"
              aria-label={`Options for ${displayName}`}
              data-testid={TEST_ID_BUILDERS.linkActions(link.id)}
              className={ROW_OPTIONS_CLASS}
            />
          }
        >
          <PrivilegeMenuChoices
            choices={LINK_PRIVILEGE_OPTIONS}
            current={link.privilege}
            labelTestId={TEST_ID_BUILDERS.linkChangePrivilege(link.id)}
            optionTestId={(priv) => TEST_ID_BUILDERS.linkPrivilegeOption(link.id, priv)}
            followed
            onChoose={(next) => onChangeLinkPrivilege?.(link.id, next)}
          />
          <MenuItem
            icon={Pencil}
            title="Change Name"
            data-testid={TEST_ID_BUILDERS.linkChangeName(link.id)}
            onSelect={handleStartEdit}
          />
          <MenuItem
            icon={Trash2}
            title="Revoke Link"
            tone="danger"
            data-testid={TEST_ID_BUILDERS.linkRevokeAction(link.id)}
            onSelect={() => onRequestRevoke?.(link.id, displayName)}
          />
        </Menu>
      )}
    </div>
  );
}
