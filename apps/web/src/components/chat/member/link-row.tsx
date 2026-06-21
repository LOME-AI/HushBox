import * as React from 'react';
import { Link as LinkIcon, MoreVertical, Pencil, Shield, Trash2 } from 'lucide-react';
import {
  IconButton,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@hushbox/ui';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { LINK_PRIVILEGE_OPTIONS } from '@/components/chat/member/member-privilege';

interface LinkRowProps {
  link: {
    id: string;
    displayName: string | null;
    privilege: string;
    createdAt: string;
  };
  index: number;
  isCurrentLink: boolean;
  isAdmin: boolean;
  onChangeLinkPrivilege?: ((linkId: string, newPrivilege: string) => void) | undefined;
  onSaveLinkName?: ((linkId: string, newName: string) => void) | undefined;
  onRequestRevoke?: ((linkId: string, displayName: string) => void) | undefined;
}

export function LinkRow({
  link,
  index,
  isCurrentLink,
  isAdmin,
  onChangeLinkPrivilege,
  onSaveLinkName,
  onRequestRevoke,
}: Readonly<LinkRowProps>): React.JSX.Element {
  const displayName = link.displayName ?? `Guest Link #${String(index + 1)}`;
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
      className="flex items-center justify-between py-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        <div
          data-testid={TEST_IDS.linkIconContainer}
          className="flex size-8 items-center justify-center"
        >
          <LinkIcon className="text-muted-foreground size-4" />
        </div>
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
          <span className="text-sm">
            {displayName}
            {isCurrentLink && (
              <span data-testid={TEST_IDS.linkYouBadge} className="text-muted-foreground ml-1">
                (you)
              </span>
            )}
          </span>
        )}
      </div>
      {isAdmin && !isEditing && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              aria-label="More options"
              data-testid={TEST_ID_BUILDERS.linkActions(link.id)}
            >
              <MoreVertical className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel
              data-testid={TEST_ID_BUILDERS.linkChangePrivilege(link.id)}
              className="flex items-center gap-2 text-xs font-normal"
            >
              <Shield className="h-4 w-4" />
              Change privilege
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={link.privilege}
              onValueChange={(next) => onChangeLinkPrivilege?.(link.id, next)}
            >
              {LINK_PRIVILEGE_OPTIONS.map((priv) => (
                <DropdownMenuRadioItem
                  key={priv}
                  value={priv}
                  data-testid={TEST_ID_BUILDERS.linkPrivilegeOption(link.id, priv)}
                >
                  {priv}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid={TEST_ID_BUILDERS.linkChangeName(link.id)}
              onSelect={handleStartEdit}
            >
              <Pencil className="mr-2 h-4 w-4" />
              Change Name
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid={TEST_ID_BUILDERS.linkRevokeAction(link.id)}
              className="text-destructive"
              onSelect={() => onRequestRevoke?.(link.id, displayName)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Revoke Link
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
