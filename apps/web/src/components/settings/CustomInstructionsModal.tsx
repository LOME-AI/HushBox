import * as React from 'react';
import { useState, useCallback } from 'react';
import { Alert, ModalOverlay, ModalActions, Textarea } from '@hushbox/ui';
import { toBase64 } from '@hushbox/shared';
import { encryptMessageForStorage, getPublicKeyFromPrivate } from '@hushbox/crypto';
import { useAuthStore } from '@/lib/auth';
import { client, fetchJson } from '@/lib/api-client';

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
  const [value, setValue] = useState(currentInstructions ?? '');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Reset state when modal opens
  React.useEffect(() => {
    if (open) {
      setValue(currentInstructions ?? '');
      setError(null);
    }
  }, [open, currentInstructions]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setError(null);

    try {
      const trimmed = value.trim();
      let encryptedBase64: string | null = null;

      if (trimmed.length > 0) {
        const privateKey = useAuthStore.getState().privateKey;
        if (!privateKey) {
          setError('Encryption key not available. Please sign in again.');
          return;
        }
        const publicKey = getPublicKeyFromPrivate(privateKey);
        const encrypted = encryptMessageForStorage(publicKey, trimmed);
        encryptedBase64 = toBase64(encrypted);
      }

      await fetchJson(
        client.api.users['custom-instructions'].$patch({
          json: { customInstructionsEncrypted: encryptedBase64 },
        })
      );

      useAuthStore.getState().setCustomInstructions(trimmed.length > 0 ? trimmed : null);
      onSuccess();
    } catch {
      setError('Failed to save custom instructions. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [value, onSuccess]);

  if (!open) return null;

  return (
    <ModalOverlay open={open} onOpenChange={onOpenChange} ariaLabel="Custom instructions">
      <div
        data-testid="custom-instructions-modal"
        className="bg-background w-[75vw] max-w-md rounded-lg border p-6 shadow-lg"
      >
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Custom Instructions</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              These instructions are included in every conversation. Tell the AI about yourself and
              {"how you'd like it to respond."}
            </p>
          </div>

          {error && <Alert>{error}</Alert>}

          <div className="space-y-2">
            <Textarea
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
              }}
              maxLength={MAX_LENGTH}
              rows={6}
              placeholder="e.g., I'm a software engineer. Be concise and use code examples."
              className="resize-none overflow-y-auto"
              style={{ height: 'calc(6 * 1.5em + 1rem)' }}
            />
            <p className="text-muted-foreground text-right text-xs">
              {value.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
            </p>
          </div>

          <ModalActions
            primary={{
              label: 'Save',
              onClick: () => void handleSave(),
              loading: isSaving,
              loadingLabel: 'Saving...',
            }}
          />
        </div>
      </div>
    </ModalOverlay>
  );
}
