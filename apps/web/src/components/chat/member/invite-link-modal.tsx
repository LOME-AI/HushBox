import * as React from 'react';
import { useState, useRef } from 'react';
import { InlineFormError, useAsyncAction, useCopyToClipboard } from '@hushbox/ui';
import { Button, IconButton } from '@hushbox/ui/button';
import { CheckField, TextField, ToggleGroup, ToggleGroupItem } from '@hushbox/ui/field';
import { AlertTriangle, Check, CircleCheck, Copy } from '@hushbox/ui/icons';
import { Notice } from '@hushbox/ui/notice';
import {
  Overlay,
  OverlayBody,
  OverlayContent,
  OverlayFooter,
  OverlayHeader,
} from '@hushbox/ui/overlay';
import { createSharedLink } from '@hushbox/crypto';
import {
  fromBase64,
  toBase64,
  MAX_CONVERSATION_MEMBERS,
  TEST_IDS,
  TEST_ID_BUILDERS,
} from '@hushbox/shared';
import { useCreateLink } from '@/hooks/realtime/use-conversation-links.js';
import { requireCurrentEpochKey } from '@/hooks/realtime/use-group-chat.js';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav.js';
import { executeWithRotation } from '@/lib/crypto/rotation.js';
import type { MemberKeyResponse, RotationMember } from '@/lib/crypto/rotation.js';
import type { CurrentEpochKey } from '@/components/chat/message/types.js';

interface InviteLinkModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  /**
   * Undefined while no verified key for the current epoch is cached. Generation is refused
   * then, and also under a bad verdict.
   */
  currentEpochKey: CurrentEpochKey | undefined;
  plaintextTitle: string;
  memberCount?: number;
}

type LinkPrivilege = 'read' | 'write';

const PRIVILEGE_CHOICES = [
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Write' },
] as const satisfies readonly { value: LinkPrivilege; label: string }[];

function isLinkPrivilege(value: string): value is LinkPrivilege {
  return PRIVILEGE_CHOICES.some((choice) => choice.value === value);
}

interface CreatedLink {
  url: string;
  privilege: LinkPrivilege;
  includeHistory: boolean;
}

function createdLinkDescription(link: CreatedLink, title: string): string {
  const allows =
    link.privilege === 'write' ? `read and send messages in ${title}` : `read ${title}`;
  return `Anyone who opens it can ${allows}${link.includeHistory ? ', including its history' : ' from now on'}.`;
}

export function InviteLinkModal({
  open,
  onOpenChange,
  conversationId,
  currentEpochKey,
  plaintextTitle,
  memberCount,
}: Readonly<InviteLinkModalProps>): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const atCapacity = memberCount !== undefined && memberCount >= MAX_CONVERSATION_MEMBERS;
  const [privilege, setPrivilege] = useState<LinkPrivilege>('read');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [createdLink, setCreatedLink] = useState<CreatedLink | null>(null);
  const privilegeLabelId = React.useId();
  const guestNameHelpId = React.useId();

  const { mutateAsync } = useCreateLink();
  // useAsyncAction wraps the generate flow: manages isPending + populates the
  // inline error region on failure. We don't use ActionModal here because the
  // success path transitions to the "show URL" phase rather than closing.
  const asyncAction = useAsyncAction();
  const { isPending, error, errorKey, run, clearError } = asyncAction;
  const generateRefused = isPending || atCapacity;

  const [previousOpen, setPreviousOpen] = useState(open);
  if (open !== previousOpen) {
    setPreviousOpen(open);
    if (open) {
      setPrivilege('read');
      setIncludeHistory(false);
      setGuestName('');
      setCreatedLink(null);
      clearError();
    }
  }

  async function handleGenerate(): Promise<void> {
    const generateResult = await run(async () => {
      const { epochNumber: currentEpochNumber, privateKey: currentEpochPrivateKey } =
        requireCurrentEpochKey(conversationId, currentEpochKey);
      const result = createSharedLink(currentEpochPrivateKey, {
        conversationId,
        epochNumber: currentEpochNumber,
      });
      const trimmedName = guestName.trim();
      const linkPublicKeyB64 = toBase64(result.linkPublicKey);
      const memberWrapB64 = toBase64(result.linkWrap);
      const linkAuthHashB64 = toBase64(result.linkAuthHash);

      if (includeHistory) {
        await mutateAsync({
          conversationId,
          linkPublicKey: linkPublicKeyB64,
          linkAuthHash: linkAuthHashB64,
          memberWrap: memberWrapB64,
          privilege,
          giveFullHistory: true,
          expectedEpoch: currentEpochNumber,
          ...(trimmedName !== '' && { displayName: trimmedName }),
        });
      } else {
        const linkPublicKey = result.linkPublicKey;
        await executeWithRotation({
          conversationId,
          currentEpochPrivateKey,
          currentEpochNumber,
          plaintextTitle,
          filterMembers: (keys: MemberKeyResponse[]): RotationMember[] => {
            const members: RotationMember[] = [];
            for (const k of keys) {
              members.push({ publicKey: fromBase64(k.publicKey) });
            }
            members.push({ publicKey: linkPublicKey });
            return members;
          },
          execute: (rotation) =>
            mutateAsync({
              conversationId,
              linkPublicKey: linkPublicKeyB64,
              linkAuthHash: linkAuthHashB64,
              memberWrap: memberWrapB64,
              privilege,
              giveFullHistory: false,
              rotation,
              ...(trimmedName !== '' && { displayName: trimmedName }),
            }),
        });
      }

      return `${globalThis.location.origin}/share/c/${conversationId}#${toBase64(result.linkSecret)}`;
    });

    if (generateResult.ok) {
      setCreatedLink({ url: generateResult.value, privilege, includeHistory });
    }
  }

  function handleCancel(): void {
    onOpenChange(false);
  }

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Invite via Link"
      dismissible={!isPending}
    >
      <OverlayContent data-testid={TEST_IDS.inviteLinkModal} size="md">
        {createdLink === null ? (
          <>
            <OverlayHeader
              title="Invite via Link"
              description="Create a link for someone without a HushBox account to access this conversation."
            />

            <OverlayBody>
              <form
                id="invite-link-form"
                ref={formRef}
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (generateRefused) return;
                  void handleGenerate();
                }}
              >
                {atCapacity && (
                  <Notice tone="error" icon={AlertTriangle} destructive emphasis="strong">
                    This conversation has reached the maximum of {MAX_CONVERSATION_MEMBERS} members.
                  </Notice>
                )}

                <Notice
                  tone="warning"
                  icon={AlertTriangle}
                  emphasis="strong"
                  data-testid={TEST_IDS.inviteLinkWarning}
                >
                  Anyone with this link can decrypt the entire conversation. Only share it with
                  people you trust.
                </Notice>

                <div>
                  <span
                    id={privilegeLabelId}
                    className="text-muted-foreground mb-1 block text-xs font-medium uppercase"
                  >
                    Permission
                  </span>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    className="w-full"
                    aria-labelledby={privilegeLabelId}
                    value={privilege}
                    onValueChange={(value) => {
                      if (isLinkPrivilege(value)) setPrivilege(value);
                    }}
                  >
                    {PRIVILEGE_CHOICES.map((choice) => (
                      <ToggleGroupItem
                        key={choice.value}
                        value={choice.value}
                        data-testid={TEST_ID_BUILDERS.inviteLinkPrivilege(choice.value)}
                      >
                        {choice.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>

                <CheckField
                  size="lg"
                  checked={includeHistory}
                  onCheckedChange={setIncludeHistory}
                  label="Give access to all history"
                  description="Leaving this unchecked will only show messages from now on"
                  testId={TEST_IDS.inviteLinkHistoryCheckbox}
                />

                <div className="flex flex-col">
                  <TextField
                    data-testid={TEST_IDS.inviteLinkNameInput}
                    type="text"
                    label="Guest name (optional)"
                    aria-describedby={guestNameHelpId}
                    value={guestName}
                    onChange={(e) => {
                      setGuestName(e.target.value);
                    }}
                  />
                  <p id={guestNameHelpId} className="text-muted-foreground -mt-0.5 text-xs">
                    This can be changed later
                  </p>
                </div>

                {privilege === 'write' && (
                  <p className="text-muted-foreground text-xs">
                    To let link guests send messages, allocate them a budget in Budgets.
                  </p>
                )}
              </form>
            </OverlayBody>

            <InlineFormError error={error} errorKey={errorKey} />

            <OverlayFooter>
              <Button
                type="button"
                variant="outline"
                onClick={handleCancel}
                data-testid={TEST_IDS.inviteLinkCancelButton}
              >
                Cancel
              </Button>
              <Button
                type="button"
                form="invite-link-form"
                onClick={() => {
                  void handleGenerate();
                }}
                disabled={generateRefused}
                data-testid={TEST_IDS.inviteLinkGenerateButton}
              >
                Generate Link
              </Button>
            </OverlayFooter>
          </>
        ) : (
          <CreatedLinkStep
            link={createdLink}
            title={plaintextTitle}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        )}
      </OverlayContent>
    </Overlay>
  );
}

interface CreatedLinkStepProps {
  link: CreatedLink;
  title: string;
  onDone: () => void;
}

// A component rather than inline JSX so the copy acknowledgement lives and dies
// with this phase: closing the modal clears the created link, which unmounts
// this and discards the acknowledgement.
function CreatedLinkStep({
  link,
  title,
  onDone,
}: Readonly<CreatedLinkStepProps>): React.JSX.Element {
  const { copy, copied } = useCopyToClipboard({ resetAfterMs: 3000 });
  const labelId = React.useId();
  const helpId = React.useId();

  return (
    <>
      <OverlayHeader title="Link created" description={createdLinkDescription(link, title)} />

      <OverlayBody>
        <div
          role="group"
          aria-labelledby={labelId}
          aria-describedby={helpId}
          className="flex flex-col gap-2"
        >
          <span id={labelId} className="text-foreground text-sm font-medium">
            Invite link
          </span>
          <div className="bg-muted flex items-center gap-2 rounded-lg py-2.5 pr-1.5 pl-3.5">
            <code
              data-testid={TEST_IDS.inviteLinkUrl}
              className="text-foreground min-w-0 flex-auto font-mono text-[0.8125rem] leading-[1.55] break-all select-all"
            >
              {link.url}
            </code>
            <IconButton
              icon={copied ? Check : Copy}
              size="sm"
              aria-label={copied ? 'Copied' : 'Copy link'}
              className="text-muted-foreground hover:text-foreground shrink-0 pointer-coarse:-my-2"
              onClick={() => {
                void copy(link.url);
              }}
              data-testid={TEST_IDS.inviteLinkCopyButton}
            />
          </div>
          <p id={helpId} className="text-muted-foreground -mt-0.5 text-xs">
            Send it whole. Everything after the # is the key; a shortened or edited link will not
            open.
          </p>
        </div>

        <Notice tone="success" icon={CircleCheck} emphasis="strong">
          You can change what it allows, or revoke it, from the member list.
        </Notice>
      </OverlayBody>

      <OverlayFooter>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </OverlayFooter>
    </>
  );
}
