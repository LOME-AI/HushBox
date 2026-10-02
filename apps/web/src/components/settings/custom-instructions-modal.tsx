import * as React from 'react';
import { useState, useCallback } from 'react';
import { UserMessageError, useAsyncAction } from '@hushbox/ui';
import { TextareaField } from '@hushbox/ui/field';
import { Lock } from '@hushbox/ui/icons';
import { toBase64, TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import { encryptCustomInstructions, getPublicKeyFromPrivate } from '@hushbox/crypto';
import { useAuthStore, selectInstructionsReadUnresolved } from '@/lib/auth/auth';
import { client, fetchJson } from '@/lib/api-client';
import { ActionModal } from '@/components/shared/action-modal';
import { TrustLine } from '@/components/shared/trust-line';

const MAX_LENGTH = 5000;

interface CustomInstructionsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function CustomInstructionsModal({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<CustomInstructionsModalProps>): React.JSX.Element | null {
  const currentInstructions = useAuthStore((s) => s.customInstructions);
  // Seeding the box from the value while the read is outstanding puts an empty
  // editor over a stored blob, and saving that empty box takes {@link handleSave}'s
  // clear arm — a DELETE against ciphertext only this account's key can open.
  const isReadUnresolved = useAuthStore(selectInstructionsReadUnresolved);
  const [value, setValue] = useState(currentInstructions ?? '');
  const asyncAction = useAsyncAction();

  const { clearError } = asyncAction;
  React.useEffect(() => {
    if (open) {
      setValue(currentInstructions ?? '');
      clearError();
    }
  }, [open, currentInstructions, clearError]);

  const handleSave = useCallback(async (): Promise<void> => {
    const trimmed = value.trim().slice(0, MAX_LENGTH);
    let encryptedBase64: string | null = null;

    if (trimmed.length > 0) {
      const { privateKey, user } = useAuthStore.getState();
      if (!privateKey || !user) {
        throw new UserMessageError(friendlyErrorMessage('ACCOUNT_KEY_NOT_AVAILABLE'));
      }
      const publicKey = getPublicKeyFromPrivate(privateKey);
      const encrypted = encryptCustomInstructions(publicKey, trimmed, user.id);
      encryptedBase64 = toBase64(encrypted);
    }

    try {
      // The rebuilt backend splits the legacy PATCH into PUT (set) and
      // DELETE (clear) on /account/instructions.
      await (encryptedBase64 === null
        ? fetchJson(client.account.instructions.$delete())
        : fetchJson(client.account.instructions.$put({ json: { instructions: encryptedBase64 } })));
    } catch {
      throw new UserMessageError(friendlyErrorMessage('CUSTOM_INSTRUCTIONS_SAVE_FAILED'));
    }

    useAuthStore.getState().setCustomInstructions(trimmed.length > 0 ? trimmed : null);
    onSuccess();
  }, [value, onSuccess]);

  if (!open) return null;

  return (
    <ActionModal
      open={open}
      onOpenChange={onOpenChange}
      title="Custom instructions"
      asyncAction={asyncAction}
      primary={{
        label: 'Save',
        loadingLabel: 'Saving...',
        onSubmit: handleSave,
        disabled: isReadUnresolved,
      }}
      cancel={{ label: 'Cancel' }}
      testId={TEST_IDS.customInstructionsModal}
      size="md"
    >
      <div className="flex flex-col gap-4">
        {isReadUnresolved ? (
          <p className="text-muted-foreground text-sm">
            Loading your saved instructions. You can edit them once they load.
          </p>
        ) : (
          <TextareaField
            label="What should every model know?"
            help="For example, your work, your tone, units, or languages."
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
            count={{ value: value.length, max: MAX_LENGTH }}
            rows={6}
            className="max-h-72 min-h-32 resize-none overflow-y-auto"
          />
        )}
        <TrustLine icon={Lock} align="start">
          Saved encrypted with a key only your devices hold. AI providers retain nothing.
        </TrustLine>
      </div>
    </ActionModal>
  );
}
