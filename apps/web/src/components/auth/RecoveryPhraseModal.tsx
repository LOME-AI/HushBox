import * as React from 'react';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { ModalOverlay, ModalActions, Input } from '@hushbox/ui';
import { Copy, Check, AlertTriangle } from 'lucide-react';
import { regenerateRecoveryPhrase } from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import { useFormEnterNav } from '@/hooks/use-form-enter-nav';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useMobileAutoFocus } from '@/hooks/use-mobile-auto-focus';
import { ModalSuccessStep } from '@/components/shared/modal-success-step';
import { useAuthStore } from '@/lib/auth';
import { getApiUrl } from '@/lib/api';

interface RecoveryPhraseModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  fromPaymentGate?: boolean;
}

type Step = 'display' | 'verify' | 'success';

interface ModalState {
  setStep: (step: Step) => void;
  setCopied: (copied: boolean) => void;
  setVerificationInputs: (inputs: string[]) => void;
  setSaving: (saving: boolean) => void;
  setError: (error: string | null) => void;
  setPhrase: (phrase: string) => void;
  setVerificationIndices: (indices: number[]) => void;
  recoveryWrappedPrivateKeyRef: React.RefObject<Uint8Array | null>;
}

async function initializeRecoveryPhrase(
  privateKey: Uint8Array | null,
  state: ModalState
): Promise<void> {
  if (!privateKey) {
    state.setError('Failed to save recovery material. Please try again.');
    return;
  }

  try {
    const result = await regenerateRecoveryPhrase(privateKey);
    state.setPhrase(result.recoveryPhrase);
    state.setVerificationIndices(generateVerificationIndices());
    state.recoveryWrappedPrivateKeyRef.current = result.recoveryWrappedPrivateKey;
  } catch (error_: unknown) {
    state.setError(error_ instanceof Error ? error_.message : 'Failed to generate recovery phrase');
  }
}

function resetModalState(state: ModalState): void {
  state.setStep('display');
  state.setCopied(false);
  state.setVerificationInputs(['', '', '']);
  state.setSaving(false);
  state.setError(null);
  state.setPhrase('');
  state.recoveryWrappedPrivateKeyRef.current = null;
}

async function performVerification(
  wrappedKeyRef: React.RefObject<Uint8Array | null>,
  setSaving: (saving: boolean) => void,
  setError: (error: string | null) => void,
  setStep: (step: Step) => void
): Promise<void> {
  setSaving(true);
  setError(null);

  try {
    const wrappedKey = wrappedKeyRef.current;
    if (!wrappedKey) {
      setError('Failed to save recovery material. Please try again.');
      setSaving(false);
      return;
    }

    await saveRecoveryMaterial(wrappedKey);
    setStep('success');
  } catch {
    setError('Failed to save recovery material. Please try again.');
  } finally {
    setSaving(false);
  }
}

function handleModalOpen(state: ModalState): void {
  resetModalState(state);
  const { privateKey } = useAuthStore.getState();
  void initializeRecoveryPhrase(privateKey, state);
}

const STEP_NUMBERS: Record<Step, number> = {
  display: 1,
  verify: 2,
  success: 3,
};

function generateVerificationIndices(): number[] {
  const indices: number[] = [];
  while (indices.length < 3) {
    const buf = new Uint8Array(1);
    crypto.getRandomValues(buf);
    const randomIndex = (buf[0] ?? 0) % 12;
    if (!indices.includes(randomIndex)) {
      indices.push(randomIndex);
    }
  }
  return indices.toSorted((a, b) => a - b);
}

function ErrorBanner({
  error,
  phrase,
}: Readonly<{ error: string | null; phrase: string }>): React.JSX.Element | null {
  if (!error || phrase) return null;
  return <p className="text-destructive text-sm">{error}</p>;
}

async function saveRecoveryMaterial(recoveryWrappedPrivateKey: Uint8Array): Promise<void> {
  const response = await fetch(`${getApiUrl()}/api/auth/recovery/save`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recoveryWrappedPrivateKey: toBase64(recoveryWrappedPrivateKey),
    }),
  });

  if (!response.ok) {
    throw new Error('API request failed');
  }
}

export function RecoveryPhraseModal({
  open,
  onOpenChange,
  onSuccess,
  fromPaymentGate = false,
}: Readonly<RecoveryPhraseModalProps>): React.JSX.Element | null {
  const isMobile = useIsMobile();
  const [step, setStep] = useState<Step>('display');
  const [phrase, setPhrase] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [verificationIndices, setVerificationIndices] = useState<number[]>([]);
  const [verificationInputs, setVerificationInputs] = useState<string[]>(['', '', '']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recoveryWrappedPrivateKeyRef = useRef<Uint8Array | null>(null);

  // Generate phrase and wrapped key when modal opens
  useEffect(() => {
    if (!open) return;

    handleModalOpen({
      setStep,
      setCopied,
      setVerificationInputs,
      setSaving,
      setError,
      setPhrase,
      setVerificationIndices,
      recoveryWrappedPrivateKeyRef,
    });
  }, [open]);

  const words = useMemo(() => phrase.split(' '), [phrase]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(phrase);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 3000);
  }, [phrase]);

  const handleProceedToVerify = useCallback(() => {
    setStep('verify');
  }, []);

  const handleBack = useCallback(() => {
    setStep('display');
  }, []);

  const handleVerificationChange = useCallback((index: number, value: string) => {
    setVerificationInputs((previous) => {
      const next = [...previous];
      next[index] = value;
      return next;
    });
  }, []);

  const verificationResults = useMemo(() => {
    return verificationIndices.map((wordIndex, inputIndex) => {
      const inputValue = verificationInputs[inputIndex]?.trim().toLowerCase() ?? '';
      const expectedWord = words[wordIndex]?.toLowerCase() ?? '';
      return inputValue !== '' && inputValue === expectedWord;
    });
  }, [verificationIndices, verificationInputs, words]);

  const allCorrect = verificationResults.every(Boolean);

  const handleVerify = useCallback(async () => {
    await performVerification(recoveryWrappedPrivateKeyRef, setSaving, setError, setStep);
  }, []);

  const handleDone = useCallback(() => {
    onSuccess();
  }, [onSuccess]);

  const handleOpenAutoFocus = useMobileAutoFocus();

  if (!open) return null;

  const currentStep = STEP_NUMBERS[step];
  const showBackButton = step === 'verify';

  return (
    <ModalOverlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Recovery phrase setup"
      onOpenAutoFocus={handleOpenAutoFocus}
      currentStep={currentStep}
      {...(showBackButton && { onBack: handleBack })}
      showCloseButton={step !== 'success' || !fromPaymentGate}
    >
      <div
        data-testid="recovery-phrase-modal"
        className="bg-background w-[75vw] max-w-xl rounded-lg border p-6 shadow-lg"
      >
        <ErrorBanner error={error} phrase={phrase} />

        {step === 'display' && phrase && (
          <DisplayStep
            words={words}
            fromPaymentGate={fromPaymentGate}
            copied={copied}
            onCopy={() => {
              void handleCopy();
            }}
            onProceed={handleProceedToVerify}
            isMobile={isMobile}
          />
        )}

        {step === 'verify' && (
          <VerifyStep
            verificationIndices={verificationIndices}
            verificationInputs={verificationInputs}
            verificationResults={verificationResults}
            allCorrect={allCorrect}
            saving={saving}
            error={error}
            onInputChange={handleVerificationChange}
            onVerify={() => {
              void handleVerify();
            }}
          />
        )}

        {step === 'success' && (
          <ModalSuccessStep
            heading="Recovery Phrase Saved"
            description="Your account is now protected. If you forget your password, use this phrase to recover your data."
            primaryLabel={fromPaymentGate ? 'Continue to Payment' : 'Done'}
            onDone={handleDone}
          />
        )}
      </div>
    </ModalOverlay>
  );
}

interface DisplayStepProps {
  words: string[];
  fromPaymentGate: boolean;
  copied: boolean;
  onCopy: () => void;
  onProceed: () => void;
  isMobile: boolean;
}

function DisplayStep({
  words,
  fromPaymentGate,
  copied,
  onCopy,
  onProceed,
  isMobile,
}: Readonly<DisplayStepProps>): React.JSX.Element {
  return (
    <div className="space-y-4">
      {fromPaymentGate && (
        <div className="bg-muted/50 rounded-md p-3 text-sm">
          Before adding credits, please save your recovery phrase.
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold">Your Recovery Phrase</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Write these 12 words down in order. Keep them somewhere safe. You will not be able to view
          this phrase again.
        </p>
      </div>

      <div
        className={`grid gap-2 ${isMobile ? 'grid-cols-2' : 'grid-cols-4'}`}
        data-testid="word-grid"
      >
        {words.map((word, index) => (
          <div
            key={index}
            className="bg-muted/50 rounded-md px-3 py-2 text-center font-mono text-sm"
          >
            {index + 1}. {word}
          </div>
        ))}
      </div>

      <div className="text-destructive flex items-start gap-2 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>If you lose your password, this is your only recovery.</span>
      </div>

      <ModalActions
        cancel={{
          label: copied ? 'Copied' : 'Copy to Clipboard',
          onClick: onCopy,
          icon: copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />,
        }}
        primary={{
          label: "I've saved it →",
          onClick: onProceed,
        }}
      />
    </div>
  );
}

interface VerifyStepProps {
  verificationIndices: number[];
  verificationInputs: string[];
  verificationResults: boolean[];
  allCorrect: boolean;
  saving: boolean;
  error: string | null;
  onInputChange: (index: number, value: string) => void;
  onVerify: () => void;
}

function VerifyStep({
  verificationIndices,
  verificationInputs,
  verificationResults,
  allCorrect,
  saving,
  error,
  onInputChange,
  onVerify,
}: Readonly<VerifyStepProps>): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Verify Your Phrase</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Enter the words at these positions to confirm you&apos;ve saved them.
        </p>
      </div>

      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          onVerify();
        }}
      >
        <div className="space-y-3">
          {verificationIndices.map((wordIndex, inputIndex) => (
            <div key={inputIndex}>
              <label className="text-sm font-medium">Word #{String(wordIndex + 1)}</label>
              <div className="relative mt-1">
                <Input
                  type="text"
                  value={verificationInputs[inputIndex] ?? ''}
                  onChange={(e) => {
                    onInputChange(inputIndex, e.target.value);
                  }}
                  placeholder={`Enter word ${String(wordIndex + 1)}`}
                  className="pr-10"
                  disabled={saving}
                />
                {verificationResults[inputIndex] && (
                  <div
                    data-testid={`word-check-${String(inputIndex)}`}
                    className="absolute top-1/2 right-3 -translate-y-1/2 text-green-500"
                  >
                    <Check className="h-4 w-4" />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </form>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <ModalActions
        primary={{
          label: 'Verify →',
          onClick: onVerify,
          disabled: !allCorrect,
          loading: saving,
          loadingLabel: 'Saving...',
        }}
      />
    </div>
  );
}
