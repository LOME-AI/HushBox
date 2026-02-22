import * as React from 'react';
import { useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import { Alert, ModalOverlay, Input, ModalActions } from '@hushbox/ui';
import { MAX_CONVERSATION_MEMBERS, displayUsername } from '@hushbox/shared';
import { CheckboxField } from '../shared/checkbox-field.js';
import { useUserSearch } from '../../hooks/use-user-search.js';

interface SelectedUser {
  id: string;
  username: string;
  publicKey: string;
}

interface AddMemberModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  memberCount?: number;
  onAddMember: (params: {
    userId: string;
    username: string;
    publicKey: string;
    privilege: string;
    giveFullHistory: boolean;
  }) => void;
}

export function AddMemberModal({
  open,
  onOpenChange,
  conversationId,
  memberCount,
  onAddMember,
}: Readonly<AddMemberModalProps>): React.JSX.Element {
  const atCapacity = memberCount !== undefined && memberCount >= MAX_CONVERSATION_MEMBERS;
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<SelectedUser | null>(null);
  const [privilege, setPrivilege] = useState('write');
  const [giveFullHistory, setGiveFullHistory] = useState(false);

  const { data } = useUserSearch(searchQuery, {
    excludeConversationId: conversationId,
  });

  const users =
    (data as { users: { id: string; username: string; publicKey: string }[] } | undefined)?.users ??
    [];

  function handleCancel(): void {
    onOpenChange(false);
  }

  function handleSubmit(): void {
    if (!selectedUser) return;
    onAddMember({
      userId: selectedUser.id,
      username: selectedUser.username,
      publicKey: selectedUser.publicKey,
      privilege,
      giveFullHistory,
    });
    onOpenChange(false);
  }

  function handleSelectUser(user: { id: string; username: string; publicKey: string }): void {
    setSelectedUser({ id: user.id, username: user.username, publicKey: user.publicKey });
    setSearchQuery('');
  }

  return (
    <ModalOverlay open={open} onOpenChange={onOpenChange} ariaLabel="Add Member">
      <div
        data-testid="add-member-modal"
        className="bg-background flex w-[90vw] max-w-md flex-col rounded-lg border p-6 shadow-lg"
      >
        <h2 className="mb-4 text-lg font-semibold">Add Member</h2>

        {atCapacity && (
          <Alert className="mb-4">
            <AlertTriangle />
            <span>
              This conversation has reached the maximum of {MAX_CONVERSATION_MEMBERS} members.
            </span>
          </Alert>
        )}

        {/* Search input + results */}
        <div className="relative mb-3">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            data-testid="add-member-search-input"
            type="text"
            placeholder="Search by username..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
            }}
            className="pl-9"
          />
          {users.length > 0 && (
            <div className="border-border bg-background absolute top-full z-10 mt-1 max-h-40 w-full overflow-y-auto rounded-md border shadow-md">
              {users.map((user) => (
                <div
                  key={user.id}
                  data-testid={`add-member-result-${user.id}`}
                  onClick={() => {
                    handleSelectUser(user);
                  }}
                  className={`hover:bg-accent flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors ${
                    selectedUser?.id === user.id ? 'bg-accent' : ''
                  }`}
                >
                  <div className="bg-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium uppercase">
                    {displayUsername(user.username).charAt(0)}
                  </div>
                  <span className="text-sm">{displayUsername(user.username)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Selected user display */}
        {selectedUser && (
          <div
            data-testid="add-member-selected"
            className="border-border mb-4 rounded-md border px-3 py-2 text-sm"
          >
            Selected: <span className="font-medium">{displayUsername(selectedUser.username)}</span>
          </div>
        )}

        {/* Privilege selector */}
        <div className="mb-3">
          <label
            htmlFor="privilege-select"
            className="text-muted-foreground mb-1 block text-xs font-medium uppercase"
          >
            Privilege
          </label>
          <select
            id="privilege-select"
            data-testid="add-member-privilege-select"
            value={privilege}
            onChange={(e) => {
              setPrivilege(e.target.value);
            }}
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        {/* History access checkbox */}
        <div className="mb-6">
          <CheckboxField
            id="history-checkbox"
            checked={giveFullHistory}
            onCheckedChange={setGiveFullHistory}
            label="Give access to all history"
            description="Leaving this unchecked will only show messages from now on"
            testId="add-member-history-checkbox"
          />
        </div>

        {/* Action buttons */}
        <ModalActions
          cancel={{
            label: 'Cancel',
            onClick: handleCancel,
            testId: 'add-member-cancel-button',
          }}
          primary={{
            label: 'Add Member',
            onClick: handleSubmit,
            disabled: !selectedUser || atCapacity,
            testId: 'add-member-submit-button',
          }}
        />
      </div>
    </ModalOverlay>
  );
}
