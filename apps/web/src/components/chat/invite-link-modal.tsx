import * as React from 'react';
import { useState, useRef } from 'react';
import { AlertTriangle, Link as LinkIcon } from 'lucide-react';
import { Alert, ModalOverlay, ModalActions, Input } from '@hushbox/ui';
import { CheckboxField } from '../shared/checkbox-field.js';
import { createSharedLink } from '@hushbox/crypto';
import { toBase64, MAX_CONVERSATION_MEMBERS } from '@hushbox/shared';
import { useCreateLink } from '../../hooks/use-conversation-links.js';
import { useFormEnterNav } from '../../hooks/use-form-enter-nav.js';

interface InviteLinkModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  currentEpochPrivateKey: Uint8Array;
  memberCount?: number;
}

export function InviteLinkModal({
  open,
  onOpenChange,
  conversationId,
  currentEpochPrivateKey,
  memberCount,
}: Readonly<InviteLinkModalProps>): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const atCapacity = memberCount !== undefined && memberCount >= MAX_CONVERSATION_MEMBERS;
  const [privilege, setPrivilege] = useState('read');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { mutateAsync, isPending } = useCreateLink();

  // Reset state when modal reopens
  const [previousOpen, setPreviousOpen] = useState(open);
  if (open !== previousOpen) {
    setPreviousOpen(open);
    if (open) {
      setPrivilege('read');
      setIncludeHistory(false);
      setGuestName('');
      setGeneratedUrl(null);
    }
  }

  async function handleGenerate(): Promise<void> {
    const result = createSharedLink(currentEpochPrivateKey);

    const trimmedName = guestName.trim();
    await mutateAsync({
      conversationId,
      linkPublicKey: toBase64(result.linkPublicKey),
      memberWrap: toBase64(result.linkWrap),
      privilege,
      giveFullHistory: includeHistory,
      ...(trimmedName !== '' && { displayName: trimmedName }),
    });

    const url = `${globalThis.location.origin}/share/c/${conversationId}#${toBase64(result.linkSecret)}`;
    setGeneratedUrl(url);
  }

  function handleCancel(): void {
    onOpenChange(false);
  }

  return (
    <ModalOverlay open={open} onOpenChange={onOpenChange} ariaLabel="Invite via Link">
      <div
        data-testid="invite-link-modal"
        className="bg-background flex w-[90vw] max-w-md flex-col rounded-lg border p-6 shadow-lg"
      >
        <h2 className="mb-4 text-lg font-semibold">Invite via Link</h2>

        {generatedUrl === null ? (
          <form
            ref={formRef}
            onSubmit={(e) => {
              e.preventDefault();
              void handleGenerate();
            }}
          >
            <p className="text-muted-foreground mb-3 text-sm">
              Create a link for someone without a HushBox account to access this conversation.
            </p>

            {atCapacity && (
              <Alert className="mb-4">
                <AlertTriangle />
                <span>
                  This conversation has reached the maximum of {MAX_CONVERSATION_MEMBERS} members.
                </span>
              </Alert>
            )}

            {/* Warning */}
            <Alert data-testid="invite-link-warning" className="mb-4">
              <AlertTriangle />
              <span>
                Anyone with this link can decrypt the entire conversation. Only share it with people
                you trust.
              </span>
            </Alert>

            {/* Permission selector */}
            <div className="mb-3">
              <label
                htmlFor="invite-privilege-select"
                className="text-muted-foreground mb-1 block text-xs font-medium uppercase"
              >
                Permission
              </label>
              <select
                id="invite-privilege-select"
                data-testid="invite-link-privilege-select"
                value={privilege}
                onChange={(e) => {
                  setPrivilege(e.target.value);
                }}
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              >
                <option value="read">Read</option>
                <option value="write">Write</option>
              </select>
            </div>

            {/* History checkbox */}
            <div className="mb-3">
              <CheckboxField
                id="invite-history-checkbox"
                checked={includeHistory}
                onCheckedChange={setIncludeHistory}
                label="Give access to all history"
                description="Leaving this unchecked will only show messages from now on"
                testId="invite-link-history-checkbox"
              />
            </div>

            {/* Guest name input */}
            <div className="mb-4">
              <label
                htmlFor="invite-name-input"
                className="text-muted-foreground mb-1 block text-xs font-medium uppercase"
              >
                Guest name (optional)
              </label>
              <Input
                id="invite-name-input"
                data-testid="invite-link-name-input"
                type="text"
                placeholder="The guest can change this later"
                value={guestName}
                onChange={(e) => {
                  setGuestName(e.target.value);
                }}
              />
            </div>

            {privilege === 'write' && (
              <p className="text-muted-foreground mb-4 text-xs">
                To let link guests send messages, allocate them a budget in Budget Settings.
              </p>
            )}

            {/* Action buttons */}
            <ModalActions
              cancel={{
                label: 'Cancel',
                onClick: handleCancel,
                testId: 'invite-link-cancel-button',
              }}
              primary={{
                label: 'Generate Link',
                onClick: () => {
                  void handleGenerate();
                },
                disabled: isPending || atCapacity,
                testId: 'invite-link-generate-button',
              }}
            />
          </form>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-2 text-sm text-green-600">
              <LinkIcon className="h-4 w-4" />
              <span>Link created! You can manage or revoke it from the member list.</span>
            </div>

            {/* Generated URL */}
            <div
              data-testid="invite-link-url"
              className="bg-muted mb-4 overflow-hidden rounded-md p-3 text-xs break-all"
            >
              {generatedUrl}
            </div>

            <ModalActions
              cancel={{
                label: 'Done',
                onClick: () => {
                  onOpenChange(false);
                },
              }}
              primary={{
                label: copied ? 'Copied' : 'Copy',
                onClick: () => {
                  void navigator.clipboard.writeText(generatedUrl);
                  setCopied(true);
                  setTimeout(() => {
                    setCopied(false);
                  }, 3000);
                },
                testId: 'invite-link-copy-button',
              }}
            />
          </>
        )}
      </div>
    </ModalOverlay>
  );
}
