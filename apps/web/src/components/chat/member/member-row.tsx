import { IconButton } from '@hushbox/ui/button';
import { Ellipsis, LogOut, UserMinus } from '@hushbox/ui/icons';
import { Menu, MenuItem } from '@hushbox/ui/menu';
import {
  canChangePrivilege,
  canRemoveMember,
  displayUsername,
  MemberPrivilege,
  TEST_IDS,
  TEST_ID_BUILDERS,
} from '@hushbox/shared';
import { PRIVILEGE_DISPLAY_ORDER } from '@/components/chat/member/member-privilege';
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
import { Avatar } from '@/components/shared/avatar';
import type * as React from 'react';
import type { MoneyFigure } from '@/lib/chat/member-money';

interface MemberRowProps {
  member: {
    id: string;
    // Link-guest members carry null userId/username (see GroupChatProps.members).
    userId: string | null;
    username: string | null;
    privilege: string;
  };
  isCurrentUser: boolean;
  isOnline: boolean;
  viewerPrivilege: MemberPrivilege;
  /** The member's figure; absent or null, the row draws none. */
  money?: MoneyFigure | null;
  onRemoveMember?: ((memberId: string) => void) | undefined;
  onChangePrivilege?: ((memberId: string, newPrivilege: string) => void) | undefined;
  onLeaveClick?: (() => void | Promise<void>) | undefined;
}

interface RowWords {
  name: string;
  /** The name as the viewer's own row shows it, with "(you)". */
  shownName: string;
  subLine: string;
}

function rowWords(
  member: Readonly<MemberRowProps['member']>,
  isCurrentUser: boolean,
  isOnline: boolean
): RowWords {
  const name = member.username === null ? 'Guest' : displayUsername(member.username);
  const privilege = privilegeWord(member.privilege);
  return {
    name,
    shownName: isCurrentUser ? `${name} (you)` : name,
    subLine: isOnline ? `${privilege} · online` : privilege,
  };
}

export function MemberRow({
  member,
  isCurrentUser,
  isOnline,
  viewerPrivilege,
  money,
  onRemoveMember,
  onChangePrivilege,
  onLeaveClick,
}: Readonly<MemberRowProps>): React.JSX.Element {
  const target = MemberPrivilege.parse(member.privilege);
  const privilegeChoices = PRIVILEGE_DISPLAY_ORDER.filter((choice) =>
    canChangePrivilege(viewerPrivilege, target, choice)
  );
  const mayRemove = canRemoveMember(viewerPrivilege, target);
  const showActions = isCurrentUser
    ? onLeaveClick !== undefined
    : privilegeChoices.length > 0 || mayRemove;
  const { name, shownName, subLine } = rowWords(member, isCurrentUser, isOnline);

  return (
    <div
      data-testid={TEST_ID_BUILDERS.memberItem(member.id)}
      data-privilege={member.privilege}
      className={ROW_CLASS}
    >
      <span
        data-testid={isOnline ? TEST_ID_BUILDERS.memberOnline(member.id) : undefined}
        className="inline-grid shrink-0 *:data-[slot=avatar]:size-8"
      >
        <Avatar name={name} online={isOnline} />
      </span>
      <span className={ROW_BODY_CLASS}>
        <span className={ROW_MAIN_CLASS}>
          <span title={shownName} className="text-ui truncate font-semibold">
            {name}
            {isCurrentUser && (
              <span data-testid={TEST_IDS.memberYouBadge} className="ml-1">
                (you)
              </span>
            )}
          </span>
          <span className={ROW_SUB_CLASS}>{subLine}</span>
        </span>
        {money !== undefined && money !== null && (
          <MoneyColumn entityId={member.id} figure={money} />
        )}
      </span>
      {showActions && (
        <Menu
          title={`Options for ${shownName}`}
          trigger={
            <IconButton
              icon={Ellipsis}
              size="sm"
              aria-label={`Options for ${shownName}`}
              data-testid={TEST_ID_BUILDERS.memberActions(member.id)}
              className={ROW_OPTIONS_CLASS}
            />
          }
        >
          {isCurrentUser ? (
            <MenuItem
              icon={LogOut}
              title="Leave"
              tone="danger"
              data-testid={TEST_IDS.memberLeaveAction}
              onSelect={() => {
                void onLeaveClick?.();
              }}
            />
          ) : (
            <>
              <PrivilegeMenuChoices
                choices={privilegeChoices}
                current={member.privilege}
                labelTestId={TEST_ID_BUILDERS.memberChangePrivilege(member.id)}
                optionTestId={(priv) => TEST_ID_BUILDERS.privilegeOption(member.id, priv)}
                followed={mayRemove}
                onChoose={(next) => onChangePrivilege?.(member.id, next)}
              />
              {mayRemove && (
                <MenuItem
                  icon={UserMinus}
                  title="Remove Member"
                  tone="danger"
                  data-testid={TEST_ID_BUILDERS.memberRemoveAction(member.id)}
                  onSelect={() => onRemoveMember?.(member.id)}
                />
              )}
            </>
          )}
        </Menu>
      )}
    </div>
  );
}
