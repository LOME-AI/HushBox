import * as React from 'react';
import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef, useId } from 'react';
import {
  UserMessageError,
  useAsyncAction,
  useCopyToClipboard,
  type UseAsyncActionReturn,
} from '@hushbox/ui';
import { Button, ButtonRow } from '@hushbox/ui/button';
import { TextField } from '@hushbox/ui/field';
import { Check, Copy, Download, Icon } from '@hushbox/ui/icons';
import { Overlay, OverlayContent, OverlayFooter, OverlayHeader } from '@hushbox/ui/overlay';
import { observeTextMetrics } from '@hushbox/ui/text-metrics';
import { regenerateRecoveryPhrase } from '@hushbox/crypto';
import {
  toBase64,
  TEST_IDS,
  TEST_ID_BUILDERS,
  friendlyErrorMessage,
  type Platform,
} from '@hushbox/shared';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav';
import { ModalSuccessStep } from '@/components/shared/modal-success-step';
import { AuthPasswordInput } from '@/components/auth/auth-password-input';
import { useAuthStore, saveRecoveryMaterial } from '@/lib/auth/auth';
import { getPlatform } from '@/capacitor/platform';
import { downloadTextFile } from '@/lib/download-text-file';

interface RecoveryPhraseModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

type Step = 'display' | 'verify' | 'password' | 'success';

/**
 * Both halves of one regenerated phrase's keypair, held together: the server
 * writes them in a single statement, and a public key stored against another
 * phrase's blob leaves the account with no working recovery path.
 */
interface RecoveryMaterial {
  readonly recoveryWrappedPrivateKey: Uint8Array;
  readonly recoveryPublicKey: Uint8Array;
}

interface ModalState {
  setStep: (step: Step) => void;
  setVerificationInputs: (inputs: string[]) => void;
  setInitError: (error: string | null) => void;
  setPhrase: (phrase: string) => void;
  setPassword: (password: string) => void;
  setVerificationIndices: (indices: number[]) => void;
  recoveryMaterialRef: React.RefObject<RecoveryMaterial | null>;
}

async function initializeRecoveryPhrase(
  privateKey: Uint8Array | null,
  state: ModalState
): Promise<void> {
  if (!privateKey) {
    state.setInitError(friendlyErrorMessage('RECOVERY_MATERIAL_SAVE_FAILED'));
    return;
  }

  try {
    const result = await regenerateRecoveryPhrase(privateKey);
    state.setPhrase(result.recoveryPhrase);
    state.setVerificationIndices(generateVerificationIndices());
    state.recoveryMaterialRef.current = {
      recoveryWrappedPrivateKey: result.recoveryWrappedPrivateKey,
      recoveryPublicKey: result.recoveryPublicKey,
    };
  } catch {
    state.setInitError(friendlyErrorMessage('RECOVERY_PHRASE_GENERATION_FAILED'));
  }
}

function resetModalState(state: ModalState, clearSaveError: () => void): void {
  state.setStep('display');
  state.setVerificationInputs(['', '', '']);
  state.setInitError(null);
  clearSaveError();
  state.setPhrase('');
  state.setPassword('');
  state.recoveryMaterialRef.current = null;
}

interface SaveArgs {
  readonly materialRef: React.RefObject<RecoveryMaterial | null>;
  readonly password: string;
  readonly epochRef: React.RefObject<number>;
  readonly entryEpoch: number;
  readonly setStep: (step: Step) => void;
}

function encodeMaterial(material: RecoveryMaterial): {
  recoveryWrappedPrivateKey: string;
  recoveryPublicKey: string;
} {
  try {
    return {
      recoveryWrappedPrivateKey: toBase64(material.recoveryWrappedPrivateKey),
      recoveryPublicKey: toBase64(material.recoveryPublicKey),
    };
  } catch {
    throw new UserMessageError(friendlyErrorMessage('RECOVERY_MATERIAL_SAVE_FAILED'));
  }
}

async function performSave(args: SaveArgs): Promise<void> {
  const material = args.materialRef.current;
  if (!material) {
    throw new UserMessageError(friendlyErrorMessage('RECOVERY_MATERIAL_SAVE_FAILED'));
  }
  const blobs = encodeMaterial(material);

  let result: Awaited<ReturnType<typeof saveRecoveryMaterial>>;
  try {
    result = await saveRecoveryMaterial(args.password, blobs);
  } catch {
    throw new UserMessageError(friendlyErrorMessage('RECOVERY_MATERIAL_SAVE_FAILED'));
  }

  if (args.epochRef.current !== args.entryEpoch) {
    return;
  }
  if (!result.success) {
    // Deliberately keeps the material: a retype is the whole recovery, and a
    // dropped ref would strand the user with a phrase the server never stored.
    throw new UserMessageError(
      result.error ?? friendlyErrorMessage('RECOVERY_MATERIAL_SAVE_FAILED')
    );
  }
  args.setStep('success');
}

const STEP_NUMBERS: Record<Step, number> = {
  display: 1,
  verify: 2,
  password: 3,
  success: 4,
};

function generateVerificationIndices(): number[] {
  const indices: number[] = [];
  while (indices.length < 3) {
    const buf = new Uint8Array(1);
    crypto.getRandomValues(buf);
    /* v8 ignore next -- buf is a length-1 Uint8Array so buf[0] is always a number; the ?? 0 only satisfies noUncheckedIndexedAccess and never fires at runtime */
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

export function RecoveryPhraseModal({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<RecoveryPhraseModalProps>): React.JSX.Element | null {
  const [step, setStep] = useState<Step>('display');
  const [phrase, setPhrase] = useState<string>('');
  const [verificationIndices, setVerificationIndices] = useState<number[]>([]);
  const [verificationInputs, setVerificationInputs] = useState<string[]>(['', '', '']);
  const [initError, setInitError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const saveAction = useAsyncAction();
  const recoveryMaterialRef = useRef<RecoveryMaterial | null>(null);
  // A ref, not the pending flag: a second submit in the same tick reads an
  // `isPending` that has not been applied yet and slips through.
  const saveInFlightRef = useRef(false);
  // Bumped on every exit from the password step. A save that resolves after the
  // user left must not pull them into the success screen, and the read must not
  // go through state, which the resolve can observe one render stale.
  const saveFlowEpochRef = useRef(0);

  const { clearError: clearSaveError } = saveAction;
  useEffect(() => {
    if (!open) return;

    const state: ModalState = {
      setStep,
      setVerificationInputs,
      setInitError,
      setPhrase,
      setPassword,
      setVerificationIndices,
      recoveryMaterialRef,
    };
    saveFlowEpochRef.current += 1;
    resetModalState(state, clearSaveError);
    const { privateKey } = useAuthStore.getState();
    void initializeRecoveryPhrase(privateKey, state);
  }, [open, clearSaveError]);

  const words = useMemo(() => phrase.split(' '), [phrase]);

  const handleProceedToVerify = useCallback(() => {
    setStep('verify');
  }, []);

  const handleBack = useCallback(() => {
    if (step === 'password') {
      saveFlowEpochRef.current += 1;
      clearSaveError();
      setStep('verify');
      return;
    }
    setStep('display');
  }, [step, clearSaveError]);

  const handleVerificationChange = useCallback((index: number, value: string) => {
    setVerificationInputs((previous) => {
      const next = [...previous];
      next[index] = value;
      return next;
    });
  }, []);

  const verificationResults = useMemo(() => {
    return verificationIndices.map((wordIndex, inputIndex) => {
      /* v8 ignore next -- verificationInputs is a fixed-length array indexed within bounds; ?. and ?? '' only satisfy noUncheckedIndexedAccess and never fire at runtime */
      const inputValue = verificationInputs[inputIndex]?.trim().toLowerCase() ?? '';
      /* v8 ignore next -- words is derived from a 12-word phrase indexed within bounds; ?. and ?? '' only satisfy noUncheckedIndexedAccess and never fire at runtime */
      const expectedWord = words[wordIndex]?.toLowerCase() ?? '';
      return inputValue !== '' && inputValue === expectedWord;
    });
  }, [verificationIndices, verificationInputs, words]);

  const allCorrect = verificationResults.every(Boolean);

  const handleVerify = useCallback((): void => {
    setStep('password');
  }, []);

  const handlePasswordChange = useCallback(
    (value: string): void => {
      setPassword(value);
      clearSaveError();
    },
    [clearSaveError]
  );

  // The guard is claimed before the first await, so a second call in the same
  // tick is refused rather than racing the first.
  const runSave = useCallback(async (): Promise<void> => {
    if (saveInFlightRef.current || password.length === 0) return;
    saveInFlightRef.current = true;
    const entryEpoch = saveFlowEpochRef.current;
    try {
      await saveAction.run(() =>
        performSave({
          materialRef: recoveryMaterialRef,
          password,
          epochRef: saveFlowEpochRef,
          entryEpoch,
          setStep,
        })
      );
    } finally {
      saveInFlightRef.current = false;
    }
  }, [password, saveAction]);

  const handleSave = useCallback((): void => {
    void runSave();
  }, [runSave]);

  const handleDone = useCallback(() => {
    onSuccess();
  }, [onSuccess]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  if (!open) return null;

  const currentStep = STEP_NUMBERS[step];
  // Withdrawn while the save is in flight rather than left inert: the overlay
  // suppresses its close button the same way, because a visible control that
  // does nothing is a UI lie.
  const showBackButton = (step === 'verify' || step === 'password') && !saveAction.isPending;

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Recovery phrase setup"
      currentStep={currentStep}
      dismissible={!saveAction.isPending}
      {...(showBackButton && { onBack: handleBack })}
    >
      <OverlayContent data-testid={TEST_IDS.recoveryPhraseModal} size="lg">
        <ErrorBanner error={initError} phrase={phrase} />

        {step === 'display' && phrase && (
          <DisplayStep
            words={words}
            phrase={phrase}
            onCancel={handleCancel}
            onProceed={handleProceedToVerify}
          />
        )}

        {step === 'verify' && (
          <VerifyStep
            verificationIndices={verificationIndices}
            verificationInputs={verificationInputs}
            verificationResults={verificationResults}
            allCorrect={allCorrect}
            onInputChange={handleVerificationChange}
            onVerify={handleVerify}
          />
        )}

        {step === 'password' && (
          <PasswordStep
            password={password}
            saveAction={saveAction}
            onPasswordChange={handlePasswordChange}
            onSave={handleSave}
          />
        )}

        {step === 'success' && (
          <ModalSuccessStep
            heading="Recovery Phrase Saved"
            description="Your account is now protected. If you forget your password, use this phrase to recover your data."
            primaryLabel="Done"
            onDone={handleDone}
          />
        )}
      </OverlayContent>
    </Overlay>
  );
}

interface DisplayStepProps {
  words: string[];
  phrase: string;
  onCancel: () => void;
  onProceed: () => void;
}

const PHRASE_FILENAME = 'hushbox-recovery-phrase.txt';

/**
 * Whether the browser's download saves a file on each platform. The web always does; inside the
 * native app a platform counts only once its download was measured on a device, and until then
 * Copy is its one way to take the phrase away.
 */
const DOWNLOAD_SAVES_FILE: Readonly<Record<Platform, boolean>> = {
  web: true,
  ios: false,
  android: false,
  'android-direct': false,
};

// The list numbers its words through a CSS counter, so each item holds the word alone. It draws
// two columns below 768px and three from 768px, and fewer wherever a column would be narrower than
// its number and its widest word as laid out (`--phrase-word`, measured below), as it is under the
// accessibility widget's larger text, reading faces and letter spacing: a word split across lines
// reads as two words.
const PHRASE_LIST_CLASS =
  'bg-background border-border-strong grid grid-cols-[repeat(auto-fill,minmax(max(calc(2rem_+_var(--phrase-word,9ch)),calc((100%_-_0.75rem)/2)),1fr))] gap-x-3 gap-y-1 rounded-lg border px-4 py-3 font-mono text-[0.9375rem] [counter-reset:phrase-word] md:grid-cols-[repeat(auto-fill,minmax(max(calc(2rem_+_var(--phrase-word,9ch)),calc((100%_-_1.5rem)/3)),1fr))]';

const PHRASE_WORD_CLASS =
  'flex min-w-0 items-baseline gap-2 leading-[2] wrap-anywhere before:w-6 before:flex-none before:text-right before:text-xs before:text-muted-foreground before:content-[counter(phrase-word)] before:[counter-increment:phrase-word]';

// CSS has no length for a word's laid-out width: `ch` is one glyph's advance in a face that may be
// proportional, and letter spacing, which the widget sets on the items, enters no unit. So the
// widest word is read from layout, each item held unbreakable for the reading only.
/**
 * The letter spacing a word carries after its last letter. Line layout reserves it, and a range's
 * width does not reliably include it, so it is added once. `normal` is none.
 */
function trailingSpacing(style: CSSStyleDeclaration): number {
  const spacing = Number.parseFloat(style.letterSpacing);
  return Number.isNaN(spacing) ? 0 : spacing;
}

/**
 * Steps per pixel a laid-out width is snapped to: finer than an engine lays text out (1/64px in
 * Chromium and WebKit, 1/60px in Firefox), coarser than the drift of a computed `width`, which
 * carries six significant digits.
 */
const LAYOUT_STEPS_PER_PX = 100;

/**
 * A word's laid-out width. A range reports the width as drawn, which includes any ancestor's
 * transform (the dialog opens scaled down, and a reading taken then would stay low); the item's
 * laid-out width over its drawn width takes that scale back out. Items carry no padding or border,
 * so their `width` is the box the drawn width measures.
 */
function laidOutWordWidth(range: Range, item: HTMLElement, style: CSSStyleDeclaration): number {
  const drawnItem = item.getBoundingClientRect().width;
  if (drawnItem === 0) return 0;
  const width = (range.getBoundingClientRect().width * Number.parseFloat(style.width)) / drawnItem;
  return Math.round(width * LAYOUT_STEPS_PER_PX) / LAYOUT_STEPS_PER_PX;
}

function measureWidestWord(list: HTMLElement): void {
  const items = [...list.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement
  );
  // `nowrap` rather than an `overflow-wrap`: the item's break utility also sets `word-break`.
  for (const item of items) item.style.whiteSpace = 'nowrap';
  const range = document.createRange();
  let widest = 0;
  for (const item of items) {
    range.selectNodeContents(item);
    const style = getComputedStyle(item);
    widest = Math.max(widest, laidOutWordWidth(range, item, style) + trailingSpacing(style));
  }
  for (const item of items) item.style.removeProperty('white-space');
  if (widest === 0) return;
  list.style.setProperty('--phrase-word', `${String(Math.ceil(widest))}px`);
}

/**
 * Keeps `--phrase-word` on the list at its widest word's laid-out width as fonts load, the root text
 * size changes (the viewport's media query and the widget's classes and styles on the root) or the
 * words change. Returns a disposer.
 */
function measurePhraseWords(list: HTMLElement): () => void {
  const measure = (): void => {
    measureWidestWord(list);
  };
  measure();
  return observeTextMetrics(measure);
}

function DisplayStep({
  words,
  phrase,
  onCancel,
  onProceed,
}: Readonly<DisplayStepProps>): React.JSX.Element {
  const { copy, copied } = useCopyToClipboard({ resetAfterMs: 3000 });
  const listRef = useRef<HTMLOListElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    // A layout effect runs once the ref is attached, so the list is always there.
    /* v8 ignore next */
    if (list === null) return;
    return measurePhraseWords(list);
  }, [words]);

  return (
    <>
      <OverlayHeader
        step={{ current: 1, total: 3 }}
        title="Save your recovery phrase"
        description="Write these 12 words down in order. If you forget your password, they're the only way back in. You won't see them again."
      />

      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- WebKit's VoiceOver drops list semantics from a list with list-style none, and the app ships in WKWebView */}
      <ol
        ref={listRef}
        role="list"
        aria-label="Recovery phrase"
        data-testid={TEST_IDS.wordGrid}
        className={PHRASE_LIST_CLASS}
      >
        {words.map((word, index) => (
          <li key={index} className={PHRASE_WORD_CLASS}>
            {word}
          </li>
        ))}
      </ol>

      <ButtonRow>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void copy(phrase);
          }}
        >
          <Icon icon={copied ? Check : Copy} />
          {copied ? 'Copied' : 'Copy'}
        </Button>
        {DOWNLOAD_SAVES_FILE[getPlatform()] && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              downloadTextFile(PHRASE_FILENAME, phrase);
            }}
          >
            <Icon icon={Download} />
            Download .txt
          </Button>
        )}
      </ButtonRow>

      <OverlayFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={onProceed}>
          I&apos;ve written it down
        </Button>
      </OverlayFooter>
    </>
  );
}

interface VerifyStepProps {
  verificationIndices: number[];
  verificationInputs: string[];
  verificationResults: boolean[];
  allCorrect: boolean;
  onInputChange: (index: number, value: string) => void;
  onVerify: () => void;
}

function VerifyStep({
  verificationIndices,
  verificationInputs,
  verificationResults,
  allCorrect,
  onInputChange,
  onVerify,
}: Readonly<VerifyStepProps>): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const fieldIdPrefix = useId();

  return (
    <div className="space-y-4">
      <OverlayHeader
        title="Verify Your Phrase"
        description="Enter the words at these positions to confirm you've saved them."
      />

      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          // Enter on the last field submits the form, which the disabled Verify cannot guard.
          if (allCorrect) onVerify();
        }}
      >
        <div className="space-y-3">
          {verificationIndices.map((wordIndex, inputIndex) => {
            const fieldId = `${fieldIdPrefix}-${String(inputIndex)}`;
            return (
              <div key={inputIndex}>
                <TextField
                  id={fieldId}
                  label={`Word #${String(wordIndex + 1)}`}
                  type="text"
                  value={
                    /* v8 ignore next -- verificationInputs is a fixed-length array indexed within bounds; the ?? '' only satisfies noUncheckedIndexedAccess and never fires at runtime */
                    verificationInputs[inputIndex] ?? ''
                  }
                  onChange={(e) => {
                    onInputChange(inputIndex, e.target.value);
                  }}
                  suffix={
                    verificationResults[inputIndex] ? (
                      <span
                        data-testid={TEST_ID_BUILDERS.wordCheck(inputIndex)}
                        className="text-success"
                      >
                        <Icon icon={Check} />
                      </span>
                    ) : undefined
                  }
                />
              </div>
            );
          })}
        </div>
      </form>

      <OverlayFooter>
        <Button type="button" onClick={onVerify} disabled={!allCorrect}>
          Verify →
        </Button>
      </OverlayFooter>
    </div>
  );
}

interface PasswordStepProps {
  password: string;
  saveAction: UseAsyncActionReturn;
  onPasswordChange: (value: string) => void;
  onSave: () => void;
}

/**
 * The gate's client half. It sits last because the step-up's finish call is the
 * one that carries the save, so the password can only be proven once the
 * material exists and the word check has passed.
 */
function PasswordStep({
  password,
  saveAction,
  onPasswordChange,
  onSave,
}: Readonly<PasswordStepProps>): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const { isPending: saving, error } = saveAction;

  return (
    <div className="space-y-4">
      <OverlayHeader
        title="Confirm Your Password"
        description="Replacing your recovery phrase needs your password, so a stolen session cannot replace it for you."
      />

      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
      >
        <AuthPasswordInput
          id="recovery-phrase-password"
          label="Password"
          value={password}
          onChange={(e) => {
            onPasswordChange(e.target.value);
          }}
          error={error ?? undefined}
        />
      </form>

      <OverlayFooter>
        <Button
          type="button"
          onClick={onSave}
          disabled={password.length === 0}
          loading={saving}
          loadingLabel="Saving..."
        >
          Replace recovery phrase
        </Button>
      </OverlayFooter>
    </div>
  );
}
