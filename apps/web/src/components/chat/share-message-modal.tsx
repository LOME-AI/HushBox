import * as React from 'react';
import { useState } from 'react';
import { Lock, Link as LinkIcon } from 'lucide-react';
import { ModalOverlay, ModalActions, Alert } from '@hushbox/ui';
import { useMessageShare } from '../../hooks/use-message-share.js';

interface ShareMessageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: string | null;
  messageContent: string | null;
}

interface ShareContentInput {
  messageId: string | null;
  messageContent: string | null;
  generatedUrl: string | null;
  copied: boolean;
  isPending: boolean;
  onCancel: () => void;
  onCreate: () => Promise<void>;
  onClose: () => void;
  onCopy: () => void;
}

function renderShareContent(input: Readonly<ShareContentInput>): React.JSX.Element {
  if (!input.messageId) {
    return (
      <div className="text-muted-foreground py-4 text-center text-sm">No message selected.</div>
    );
  }

  if (input.generatedUrl === null) {
    return (
      <>
        {/* Message preview */}
        <div
          data-testid="share-message-preview"
          className="border-border mb-4 rounded-md border p-3"
        >
          <p className="line-clamp-4 text-sm">{input.messageContent}</p>
        </div>

        {/* Isolation info */}
        <Alert variant="default" data-testid="share-message-isolation-info" className="mb-4">
          <Lock />
          <span>
            Cryptographically isolated. This link gives access to this single message only.
          </span>
        </Alert>

        {/* Action buttons */}
        <ModalActions
          cancel={{
            label: 'Cancel',
            onClick: input.onCancel,
            testId: 'share-message-cancel-button',
          }}
          primary={{
            label: 'Create Link',
            onClick: () => {
              void input.onCreate();
            },
            disabled: input.isPending,
            testId: 'share-message-create-button',
          }}
        />
      </>
    );
  }

  return (
    <>
      <div className="mb-4 flex items-center gap-2 text-sm text-green-600">
        <LinkIcon className="h-4 w-4" />
        <span>Share link created!</span>
      </div>

      {/* Generated URL */}
      <div
        data-testid="share-message-url"
        className="bg-muted mb-4 overflow-hidden rounded-md p-3 text-xs break-all"
      >
        {input.generatedUrl}
      </div>

      <ModalActions
        cancel={{
          label: 'Done',
          onClick: input.onClose,
        }}
        primary={{
          label: input.copied ? 'Copied' : 'Copy',
          onClick: input.onCopy,
          testId: 'share-message-copy-button',
        }}
      />
    </>
  );
}

export function ShareMessageModal({
  open,
  onOpenChange,
  messageId,
  messageContent,
}: Readonly<ShareMessageModalProps>): React.JSX.Element {
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const share = useMessageShare();
  const mutateAsync = (
    share as {
      mutateAsync: (args: {
        messageId: string;
        plaintextContent: string;
      }) => Promise<{ shareId: string; url: string }>;
      isPending: boolean;
    }
  ).mutateAsync;
  const isPending = (share as { isPending: boolean }).isPending;

  // Reset state when modal reopens
  const [previousOpen, setPreviousOpen] = useState(open);
  if (open !== previousOpen) {
    setPreviousOpen(open);
    setGeneratedUrl(null);
  }

  async function handleCreate(): Promise<void> {
    if (!messageId || !messageContent) return;

    const result = await mutateAsync({
      messageId,
      plaintextContent: messageContent,
    });

    setGeneratedUrl(result.url);
  }

  function handleCancel(): void {
    onOpenChange(false);
  }

  return (
    <ModalOverlay open={open} onOpenChange={onOpenChange} ariaLabel="Share Message">
      <div
        data-testid="share-message-modal"
        className="bg-background flex w-[90vw] max-w-md flex-col rounded-lg border p-6 shadow-lg"
      >
        <h2 className="mb-4 text-lg font-semibold">Share Message</h2>

        {renderShareContent({
          messageId,
          messageContent,
          generatedUrl,
          copied,
          isPending,
          onCancel: handleCancel,
          onCreate: handleCreate,
          onClose: () => {
            onOpenChange(false);
          },
          onCopy: () => {
            if (generatedUrl) {
              void navigator.clipboard.writeText(generatedUrl);
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 3000);
            }
          },
        })}
      </div>
    </ModalOverlay>
  );
}
