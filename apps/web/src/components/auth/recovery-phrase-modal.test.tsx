import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TEST_ID_BUILDERS, toBase64, type Platform } from '@hushbox/shared';
import { observeTextMetrics } from '@hushbox/ui/text-metrics';
import { RecoveryPhraseModal } from './recovery-phrase-modal';

vi.mock('@hushbox/ui/text-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui/text-metrics')>();
  return { observeTextMetrics: vi.fn(actual.observeTextMetrics) };
});

const mockRecoveryWrappedPrivateKey = new Uint8Array([10, 20, 30, 40, 50]);
const mockRecoveryPublicKey = new Uint8Array([60, 70, 80, 90, 100]);
const mockRegenerateRecoveryPhrase = vi.fn().mockResolvedValue({
  recoveryPhrase: 'apple brave candy delta eagle frost globe happy ivory joker kite lemon',
  recoveryWrappedPrivateKey: mockRecoveryWrappedPrivateKey,
  recoveryPublicKey: mockRecoveryPublicKey,
});
const mockToBase64 = vi.fn();

vi.mock('@hushbox/crypto', () => ({
  regenerateRecoveryPhrase: (...args: unknown[]) => mockRegenerateRecoveryPhrase(...args),
  toBase64: (...args: unknown[]) => mockToBase64(...args),
}));

const mockPrivateKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const mockSaveRecoveryMaterial = vi.fn();
vi.mock('@/lib/auth/auth', () => ({
  useAuthStore: {
    getState: vi.fn(() => ({ privateKey: mockPrivateKey })),
  },
  saveRecoveryMaterial: (...args: unknown[]) => mockSaveRecoveryMaterial(...args),
}));

const TEST_PASSWORD = 'correct horse battery';

/** Holds the gated save open so the in-flight window is observable. */
function holdSave(): { release: (value: { success: boolean }) => void } {
  let release!: (value: { success: boolean }) => void;
  mockSaveRecoveryMaterial.mockReturnValueOnce(
    new Promise<{ success: boolean }>((resolve) => {
      release = resolve;
    })
  );
  return { release };
}

vi.mock('@/lib/api/api', () => ({
  getApiUrl: vi.fn(() => 'http://localhost:8787'),
}));

const mockDownloadTextFile = vi.fn<(filename: string, text: string) => void>();
vi.mock('@/lib/download-text-file', () => ({
  downloadTextFile: (filename: string, text: string) => {
    mockDownloadTextFile(filename, text);
  },
}));

const platform: { name: Platform } = { name: 'web' };
vi.mock('@/capacitor/platform', () => ({
  isNative: () => platform.name !== 'web',
  getPlatform: () => platform.name,
}));

const MODAL_SOURCES = import.meta.glob<string>('./recovery-phrase-modal.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const PHRASE = 'apple brave candy delta eagle frost globe happy ivory joker kite lemon';

async function fillVerificationInputs(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const labels = screen.getAllByText(/word #\d+/i);
  const inputs = screen.getAllByRole('textbox');
  const words = [
    'apple',
    'brave',
    'candy',
    'delta',
    'eagle',
    'frost',
    'globe',
    'happy',
    'ivory',
    'joker',
    'kite',
    'lemon',
  ];

  for (const [index, label] of labels.entries()) {
    if (!label.textContent) continue;
    const wordNumber = Number.parseInt(/\d+/.exec(label.textContent)?.[0] ?? '0', 10);
    const expectedWord = words[wordNumber - 1];
    const input = inputs[index];
    if (!input) throw new Error(`Expected input at index ${String(index)}`);
    await user.type(input, expectedWord ?? '');
  }
}

async function navigateToPasswordStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /i've written it down/i }));
  await fillVerificationInputs(user);
  await user.click(screen.getByRole('button', { name: /verify/i }));
}

function passwordField(): HTMLElement {
  // Exact: the visibility toggle inside AuthPasswordInput carries its own
  // "Show password" aria-label, which a loose matcher would also pick up.
  return screen.getByLabelText('Password');
}

async function submitPassword(
  user: ReturnType<typeof userEvent.setup>,
  password = TEST_PASSWORD
): Promise<void> {
  await user.type(passwordField(), password);
  await user.click(screen.getByRole('button', { name: /replace recovery phrase/i }));
}

async function navigateToSuccessWithDefaults(
  user: ReturnType<typeof userEvent.setup>
): Promise<void> {
  await navigateToPasswordStep(user);
  await submitPassword(user);
}

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  onSuccess: vi.fn(),
};

/** Renders the modal and drives it all the way to the success screen. */
async function renderAndCompleteFlow(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<RecoveryPhraseModal {...defaultProps} />);
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /i've written it down/i })).toBeInTheDocument();
  });
  await navigateToSuccessWithDefaults(user);
  await waitFor(() => {
    expect(screen.getByText('Recovery Phrase Saved')).toBeInTheDocument();
  });
  return user;
}

describe('RecoveryPhraseModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.name = 'web';
    mockToBase64.mockImplementation((data: Uint8Array) => btoa(String.fromCodePoint(...data)));
    mockSaveRecoveryMaterial.mockResolvedValue({ success: true });
    mockRegenerateRecoveryPhrase.mockResolvedValue({
      recoveryPhrase: 'apple brave candy delta eagle frost globe happy ivory joker kite lemon',
      recoveryWrappedPrivateKey: mockRecoveryWrappedPrivateKey,
      recoveryPublicKey: mockRecoveryPublicKey,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        { success: true },
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );
  });

  describe('Step 1: Display', () => {
    async function renderDisplayStep(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByRole('list', { name: 'Recovery phrase' })).toBeInTheDocument();
      });
      return user;
    }

    it('names the dialog with the visible step heading', async () => {
      await renderDisplayStep();

      expect(screen.getByRole('dialog')).toHaveAccessibleName('Save your recovery phrase');
    });

    it('shows the step count above the title', async () => {
      await renderDisplayStep();

      expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    });

    it('explains why the words matter and that they will not be shown again', async () => {
      await renderDisplayStep();

      expect(
        screen.getByText(
          "Write these 12 words down in order. If you forget your password, they're the only way back in. You won't see them again."
        )
      ).toBeInTheDocument();
    });

    it('lists the twelve words in order as one list', async () => {
      await renderDisplayStep();

      const list = screen.getByRole('list', { name: 'Recovery phrase' });
      const items = within(list).getAllByRole('listitem');
      expect(items.map((item) => item.textContent)).toEqual(PHRASE.split(' '));
    });

    it('draws the list as an ordered list, so the list numbers the words', async () => {
      await renderDisplayStep();

      expect(screen.getByRole('list', { name: 'Recovery phrase' }).tagName).toBe('OL');
    });

    it('names its list role outright, since WebKit drops it from a list drawn without markers', async () => {
      await renderDisplayStep();

      expect(screen.getByRole('list', { name: 'Recovery phrase' })).toHaveAttribute('role', 'list');
    });

    it('shows no separate warning line', async () => {
      await renderDisplayStep();

      expect(screen.queryByText(/this is your only recovery/i)).not.toBeInTheDocument();
    });

    it('copies the phrase to the clipboard', async () => {
      const user = await renderDisplayStep();

      await user.click(screen.getByRole('button', { name: 'Copy' }));

      await waitFor(async () => {
        expect(await navigator.clipboard.readText()).toBe(PHRASE);
      });
    });

    it('acknowledges the copy', async () => {
      const user = await renderDisplayStep();

      await user.click(screen.getByRole('button', { name: 'Copy' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
      });
    });

    it('does not acknowledge the copy when the clipboard write fails', async () => {
      const user = await renderDisplayStep();
      // userEvent.setup() installs its own navigator.clipboard stub, so a failing
      // clipboard has to replace it after the session exists, not before.
      const writeText = vi.fn().mockRejectedValue(new Error('clipboard refused'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      await user.click(screen.getByRole('button', { name: 'Copy' }));

      await waitFor(() => {
        expect(writeText).toHaveBeenCalled();
      });
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /copied/i })).not.toBeInTheDocument();
    });

    it('clears the copy acknowledgement when the display step is returned to', async () => {
      const user = await renderDisplayStep();
      await user.click(screen.getByRole('button', { name: 'Copy' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /i've written it down/i }));
      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /copied/i })).not.toBeInTheDocument();
    });

    it('saves the phrase, and only the phrase, as hushbox-recovery-phrase.txt', async () => {
      const user = await renderDisplayStep();

      await user.click(screen.getByRole('button', { name: 'Download .txt' }));

      expect(mockDownloadTextFile).toHaveBeenCalledExactlyOnceWith(
        'hushbox-recovery-phrase.txt',
        PHRASE
      );
    });

    it.each(['ios', 'android', 'android-direct'] as const)(
      'hides Download inside the %s app, where no download was measured to work',
      async (name) => {
        platform.name = name;

        await renderDisplayStep();

        expect(screen.queryByRole('button', { name: 'Download .txt' })).not.toBeInTheDocument();
      }
    );

    it('keeps Copy inside the native app', async () => {
      platform.name = 'ios';

      await renderDisplayStep();

      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    });

    it('closes the dialog on Cancel', async () => {
      const user = await renderDisplayStep();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
    });

    it('advances to the word check when "I\'ve written it down" is clicked', async () => {
      const user = await renderDisplayStep();

      await user.click(screen.getByRole('button', { name: "I've written it down" }));

      expect(screen.getByText('Verify Your Phrase')).toBeInTheDocument();
    });

    it('calls regenerateRecoveryPhrase with account private key when modal opens', async () => {
      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(mockRegenerateRecoveryPhrase).toHaveBeenCalledWith(mockPrivateKey);
      });
    });

    it('lays out the list without reading the viewport band in script', () => {
      const sources = Object.values(MODAL_SOURCES);

      expect(sources).toHaveLength(1);
      expect(sources[0]).not.toMatch(/\buseIsMobile\b/);
    });
  });
  describe('word list column floor', () => {
    const PROPERTY = '--phrase-word';
    /** The width each item is laid out at in the stubbed layout, in px. */
    const ITEM_WIDTH = 200;
    /**
     * Laid-out width of each character in the stubbed layout, in px, and the scale everything is
     * drawn at, as a transform on an ancestor draws it.
     */
    const drawn = { perCharacter: 10, scale: 1 };
    const itemWidth = document.createElement('style');
    itemWidth.textContent = `li { width: ${String(ITEM_WIDTH)}px; }`;

    beforeEach(() => {
      drawn.perCharacter = 10;
      drawn.scale = 1;
      document.head.append(itemWidth);
      // Test DOMs lay nothing out, so a word's drawn width comes from its length.
      vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Range
      ): DOMRect {
        return new DOMRect(
          0,
          0,
          (this.toString().length * drawn.perCharacter + 0.4) * drawn.scale,
          20
        );
      });
      const elementRect = HTMLElement.prototype.getBoundingClientRect;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ): DOMRect {
        return this instanceof HTMLLIElement
          ? new DOMRect(0, 0, ITEM_WIDTH * drawn.scale, 20)
          : elementRect.call(this);
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      itemWidth.remove();
      document.documentElement.classList.remove('phrase-word-test');
    });

    async function renderedList(): Promise<HTMLElement> {
      render(<RecoveryPhraseModal {...defaultProps} />);
      return screen.findByRole('list', { name: 'Recovery phrase' });
    }

    /** Installs a font set the page can listen on, as a browser document has. */
    function installFontSet(): EventTarget {
      const fonts = new EventTarget();
      Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
      return fonts;
    }

    function removeFontSet(): void {
      Reflect.deleteProperty(document, 'fonts');
    }

    it("sets the floor to the widest word's laid-out width, rounded up to a whole pixel", async () => {
      const list = await renderedList();

      expect(list.style.getPropertyValue(PROPERTY)).toBe('51px');
    });

    it('reads each word at its laid-out width while the dialog is drawn scaled', async () => {
      drawn.scale = 0.95;

      const list = await renderedList();

      expect(list.style.getPropertyValue(PROPERTY)).toBe('51px');
    });

    it('keeps a word laid out at a whole pixel at that pixel when its item width is serialized to six digits', async () => {
      vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 80, 20));
      const serialized = document.createElement('style');
      // A computed width carries six significant digits, so it can sit a hair past the drawn one.
      serialized.textContent = `li { width: ${String(ITEM_WIDTH)}.001px; }`;
      document.head.append(serialized);
      try {
        const list = await renderedList();

        expect(list.style.getPropertyValue(PROPERTY)).toBe('80px');
      } finally {
        serialized.remove();
      }
    });

    it('adds the letter spacing a word carries after its last letter', async () => {
      const spacing = document.createElement('style');
      spacing.textContent = 'li { letter-spacing: 2px; }';
      document.head.append(spacing);
      try {
        const list = await renderedList();

        expect(list.style.getPropertyValue(PROPERTY)).toBe('53px');
      } finally {
        spacing.remove();
      }
    });

    it('gives each word back its wrapping once the reading is taken', async () => {
      const list = await renderedList();

      for (const item of within(list).getAllByRole('listitem')) {
        expect(item.style.whiteSpace).toBe('');
      }
    });

    it('measures again when the page text settings change', async () => {
      const list = await renderedList();

      drawn.perCharacter = 20;
      document.documentElement.classList.add('phrase-word-test');

      await waitFor(() => {
        expect(list.style.getPropertyValue(PROPERTY)).toBe('101px');
      });
    });

    it('measures again when the window resizes', async () => {
      const list = await renderedList();

      drawn.perCharacter = 20;
      globalThis.dispatchEvent(new Event('resize'));

      expect(list.style.getPropertyValue(PROPERTY)).toBe('101px');
    });

    it('measures again when a font finishes loading', async () => {
      const fonts = installFontSet();
      try {
        const list = await renderedList();

        drawn.perCharacter = 20;
        fonts.dispatchEvent(new Event('loadingdone'));

        expect(list.style.getPropertyValue(PROPERTY)).toBe('101px');
      } finally {
        removeFontSet();
      }
    });

    it('measures again on each change the shared text-metric observer reports', async () => {
      const list = await renderedList();
      const onChange = vi.mocked(observeTextMetrics).mock.lastCall?.[0];

      drawn.perCharacter = 20;
      onChange?.();

      expect(list.style.getPropertyValue(PROPERTY)).toBe('101px');
    });

    it('releases every text-metric observer it took once the list goes away', async () => {
      const release = vi.fn();
      vi.mocked(observeTextMetrics).mockClear().mockReturnValue(release);
      try {
        const view = render(<RecoveryPhraseModal {...defaultProps} />);
        await screen.findByRole('list', { name: 'Recovery phrase' });
        const taken = vi.mocked(observeTextMetrics).mock.calls.length;

        view.unmount();

        expect(taken).toBeGreaterThan(0);
        expect(release).toHaveBeenCalledTimes(taken);
      } finally {
        vi.mocked(observeTextMetrics).mockReset();
      }
    });

    it('leaves the floor alone while nothing is drawn', async () => {
      drawn.perCharacter = 0;
      vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect());

      const list = await renderedList();

      expect(list.style.getPropertyValue(PROPERTY)).toBe('');
    });

    it('leaves the floor alone while no item is laid out', async () => {
      itemWidth.remove();
      drawn.scale = 0;

      const list = await renderedList();

      expect(list.style.getPropertyValue(PROPERTY)).toBe('');
    });

    it('stops measuring once the list goes away', async () => {
      const fonts = installFontSet();
      try {
        const view = render(<RecoveryPhraseModal {...defaultProps} />);
        const list = await screen.findByRole('list', { name: 'Recovery phrase' });

        view.unmount();
        drawn.perCharacter = 20;
        fonts.dispatchEvent(new Event('loadingdone'));
        globalThis.dispatchEvent(new Event('resize'));
        document.documentElement.classList.add('phrase-word-test');
        await new Promise<void>((resolve) => {
          queueMicrotask(resolve);
        });

        expect(list.style.getPropertyValue(PROPERTY)).toBe('51px');
      } finally {
        removeFontSet();
      }
    });
  });

  describe('Step 2: Verify', () => {
    async function goToStep2(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've written it down/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /i've written it down/i }));
      return user;
    }

    it('shows verification step after proceeding from display', async () => {
      await goToStep2();

      expect(screen.getByText('Verify Your Phrase')).toBeInTheDocument();
      expect(screen.getByText(/enter the words at these positions/i)).toBeInTheDocument();
    });

    it('shows 3 input fields for word verification', async () => {
      await goToStep2();

      const inputs = screen.getAllByRole('textbox');
      expect(inputs).toHaveLength(3);
    });

    it('associates each verification label with its input', async () => {
      await goToStep2();

      const labels = screen.getAllByText<HTMLLabelElement>(/word #\d+/i);
      expect(labels).toHaveLength(3);
      for (const label of labels) {
        const input = screen.getByLabelText(label.textContent);
        expect(input).toHaveAttribute('type', 'text');
      }
    });

    it('shows back button on step 2', async () => {
      await goToStep2();

      expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    });

    it('goes back to step 1 when back button is clicked', async () => {
      const user = await goToStep2();

      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByText('Save your recovery phrase')).toBeInTheDocument();
    });

    it('verify button is disabled until all 3 words are correct', async () => {
      await goToStep2();

      const verifyButton = screen.getByRole('button', { name: /verify/i });
      expect(verifyButton).toBeDisabled();
    });

    it('shows checkmark when word is correct', async () => {
      const user = await goToStep2();

      const labels = screen.getAllByText(/word #\d+/i);
      const firstLabel = labels[0];
      if (!firstLabel?.textContent) throw new Error('Label not found');

      const wordNumber = Number.parseInt(/\d+/.exec(firstLabel.textContent)?.[0] ?? '0', 10);
      const words = [
        'apple',
        'brave',
        'candy',
        'delta',
        'eagle',
        'frost',
        'globe',
        'happy',
        'ivory',
        'joker',
        'kite',
        'lemon',
      ];
      const expectedWord = words[wordNumber - 1];

      const inputs = screen.getAllByRole('textbox');
      const firstInput = inputs[0];
      if (!firstInput) throw new Error('Expected first input');
      await user.type(firstInput, expectedWord ?? '');

      expect(screen.getByTestId(TEST_ID_BUILDERS.wordCheck(0))).toBeInTheDocument();
    });

    it('enables verify button when all 3 words are correct', async () => {
      const user = await goToStep2();

      const labels = screen.getAllByText(/word #\d+/i);
      const inputs = screen.getAllByRole('textbox');
      const words = [
        'apple',
        'brave',
        'candy',
        'delta',
        'eagle',
        'frost',
        'globe',
        'happy',
        'ivory',
        'joker',
        'kite',
        'lemon',
      ];

      for (const [index, label] of labels.entries()) {
        if (!label.textContent) continue;
        const wordNumber = Number.parseInt(/\d+/.exec(label.textContent)?.[0] ?? '0', 10);
        const expectedWord = words[wordNumber - 1];
        const input = inputs[index];
        if (!input) throw new Error(`Expected input at index ${String(index)}`);
        await user.type(input, expectedWord ?? '');
      }

      const verifyButton = screen.getByRole('button', { name: /verify/i });
      expect(verifyButton).not.toBeDisabled();
    });

    /** Types the right word into every field but the last, which gets a wrong one. */
    async function fillWithOneWrongWord(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      const words = PHRASE.split(' ');
      const labels = screen.getAllByText(/word #\d+/i);
      const inputs = screen.getAllByRole('textbox');
      for (const [index, label] of labels.entries()) {
        const wordNumber = Number.parseInt(/\d+/.exec(label.textContent)?.[0] ?? '0', 10);
        const input = inputs[index];
        if (!input) throw new Error(`Expected input at index ${String(index)}`);
        const isLast = index === labels.length - 1;
        await user.type(input, isLast ? 'zebra' : (words[wordNumber - 1] ?? ''));
      }
    }

    it('keeps Verify disabled while one word is wrong, and sends nothing', async () => {
      const user = await goToStep2();
      await fillWithOneWrongWord(user);

      const verifyButton = screen.getByRole('button', { name: /verify/i });
      expect(verifyButton).toBeDisabled();
      await user.click(verifyButton);

      expect(screen.getByText('Verify Your Phrase')).toBeInTheDocument();
      expect(screen.queryByText('Confirm Your Password')).not.toBeInTheDocument();
      expect(mockSaveRecoveryMaterial).not.toHaveBeenCalled();
    });

    it('stays on the word check when Enter is pressed with one word wrong', async () => {
      const user = await goToStep2();
      await fillWithOneWrongWord(user);

      await user.keyboard('{Enter}');

      expect(screen.getByText('Verify Your Phrase')).toBeInTheDocument();
      expect(screen.queryByText('Confirm Your Password')).not.toBeInTheDocument();
    });

    it('Enter on first verification input focuses second input', async () => {
      const user = await goToStep2();

      const inputs = screen.getAllByRole('textbox');
      await user.click(inputs[0]!);
      await user.keyboard('{Enter}');

      expect(inputs[1]).toHaveFocus();
    });

    it('Enter on last verification input triggers verify when all correct', async () => {
      const user = await goToStep2();
      await fillVerificationInputs(user);

      const inputs = screen.getAllByRole('textbox');
      await user.click(inputs[2]!);
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(screen.getByText('Confirm Your Password')).toBeInTheDocument();
      });
    });

    it('advances to the password step when verify is clicked with correct words', async () => {
      const user = await goToStep2();
      await fillVerificationInputs(user);

      await user.click(screen.getByRole('button', { name: /verify/i }));

      expect(screen.getByText('Confirm Your Password')).toBeInTheDocument();
      expect(screen.queryByText('Recovery Phrase Saved')).not.toBeInTheDocument();
      expect(mockSaveRecoveryMaterial).not.toHaveBeenCalled();
    });
  });

  describe('Step 3: Password', () => {
    async function goToPasswordStep(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've written it down/i })).toBeInTheDocument();
      });
      await navigateToPasswordStep(user);
      return user;
    }

    it('explains why the password is being asked for', async () => {
      await goToPasswordStep();

      expect(screen.getByText(/replacing your recovery phrase needs your password/i)).toBeVisible();
    });

    it('sends the regenerated material with the proven password', async () => {
      const user = await goToPasswordStep();

      await submitPassword(user);

      await waitFor(() => {
        expect(mockSaveRecoveryMaterial).toHaveBeenCalledWith(TEST_PASSWORD, {
          recoveryWrappedPrivateKey: toBase64(mockRecoveryWrappedPrivateKey),
          recoveryPublicKey: toBase64(mockRecoveryPublicKey),
        });
      });
      expect(screen.getByText('Recovery Phrase Saved')).toBeInTheDocument();
    });

    it('cannot be submitted with an empty password', async () => {
      await goToPasswordStep();

      expect(screen.getByRole('button', { name: /replace recovery phrase/i })).toBeDisabled();
    });

    it('keeps the generated material when the password is refused', async () => {
      const user = await goToPasswordStep();
      mockSaveRecoveryMaterial.mockResolvedValueOnce({
        success: false,
        error: 'Incorrect password.',
      });

      await submitPassword(user, 'wrong password');
      await waitFor(() => {
        expect(screen.getByText('Incorrect password.')).toBeInTheDocument();
      });

      // The retype is the whole recovery: the same material must still be there.
      await user.clear(passwordField());
      await submitPassword(user);

      await waitFor(() => {
        expect(screen.getByText('Recovery Phrase Saved')).toBeInTheDocument();
      });
      expect(mockSaveRecoveryMaterial).toHaveBeenNthCalledWith(2, TEST_PASSWORD, {
        recoveryWrappedPrivateKey: toBase64(mockRecoveryWrappedPrivateKey),
        recoveryPublicKey: toBase64(mockRecoveryPublicKey),
      });
    });

    it('announces the failure on the field that caused it', async () => {
      const user = await goToPasswordStep();
      mockSaveRecoveryMaterial.mockResolvedValueOnce({
        success: false,
        error: 'Incorrect password.',
      });

      await submitPassword(user, 'wrong password');

      const field = await waitFor(() => {
        const input = passwordField();
        expect(input).toHaveAttribute('aria-invalid', 'true');
        return input;
      });
      const describedBy = field.getAttribute('aria-describedby');
      expect(describedBy).not.toBeNull();
      expect(document.querySelector(`#${describedBy!}`)).toHaveTextContent('Incorrect password.');
    });

    it('clears the failure once the password is edited', async () => {
      const user = await goToPasswordStep();
      mockSaveRecoveryMaterial.mockResolvedValueOnce({
        success: false,
        error: 'Incorrect password.',
      });

      await submitPassword(user, 'wrong password');
      await waitFor(() => {
        expect(screen.getByText('Incorrect password.')).toBeInTheDocument();
      });

      await user.type(passwordField(), 'x');

      await waitFor(() => {
        expect(screen.queryByText('Incorrect password.')).not.toBeInTheDocument();
      });
      expect(passwordField()).not.toHaveAttribute('aria-invalid');
    });

    it('withdraws the back control while the save is in flight', async () => {
      const user = await goToPasswordStep();
      const held = holdSave();
      expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();

      await submitPassword(user);

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
      });

      held.release({ success: true });
      await waitFor(() => {
        expect(screen.getByText('Recovery Phrase Saved')).toBeInTheDocument();
      });
    });

    it('runs one save when the form is submitted twice before the first settles', async () => {
      const user = await goToPasswordStep();
      const held = holdSave();

      await user.type(passwordField(), TEST_PASSWORD);
      // Enter reaches the form directly, so an impatient second press is not
      // stopped by the submit button's disabled state.
      await user.keyboard('{Enter}');
      await user.keyboard('{Enter}');

      expect(mockSaveRecoveryMaterial).toHaveBeenCalledTimes(1);
      held.release({ success: true });
      await waitFor(() => {
        expect(screen.getByText('Recovery Phrase Saved')).toBeInTheDocument();
      });
    });

    it('returns to the word check when back is used', async () => {
      const user = await goToPasswordStep();

      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByText('Verify Your Phrase')).toBeInTheDocument();
      expect(mockSaveRecoveryMaterial).not.toHaveBeenCalled();
    });

    it('ignores a save that lands after the flow was restarted', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<RecoveryPhraseModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've written it down/i })).toBeInTheDocument();
      });
      await navigateToPasswordStep(user);
      const held = holdSave();
      await submitPassword(user);

      // Closed and reopened: a brand new phrase is on screen, and the old
      // save's result belongs to material the user can no longer see.
      rerender(<RecoveryPhraseModal {...defaultProps} open={false} />);
      rerender(<RecoveryPhraseModal {...defaultProps} open={true} />);
      await waitFor(() => {
        expect(screen.getByText('Save your recovery phrase')).toBeInTheDocument();
      });
      held.release({ success: true });

      await waitFor(() => {
        expect(mockSaveRecoveryMaterial).toHaveBeenCalledTimes(1);
      });
      expect(screen.queryByText('Recovery Phrase Saved')).not.toBeInTheDocument();
      expect(screen.getByText('Save your recovery phrase')).toBeInTheDocument();
    });

    it('leaves the restarted flow its own material when a stale save lands', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<RecoveryPhraseModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've written it down/i })).toBeInTheDocument();
      });
      await navigateToPasswordStep(user);
      const held = holdSave();
      await submitPassword(user);

      rerender(<RecoveryPhraseModal {...defaultProps} open={false} />);
      rerender(<RecoveryPhraseModal {...defaultProps} open={true} />);
      await waitFor(() => {
        expect(screen.getByText('Save your recovery phrase')).toBeInTheDocument();
      });
      held.release({ success: true });
      await waitFor(() => {
        expect(mockSaveRecoveryMaterial).toHaveBeenCalledTimes(1);
      });

      // The stale attempt owns the material it captured, not whatever the ref
      // holds when it lands: the reopened flow's own phrase must still save.
      await navigateToSuccessWithDefaults(user);

      await waitFor(() => {
        expect(screen.getByText('Recovery Phrase Saved')).toBeInTheDocument();
      });
      expect(mockSaveRecoveryMaterial).toHaveBeenCalledTimes(2);
    });
  });

  describe('Step 4: Success', () => {
    const goToSuccess = renderAndCompleteFlow;

    it('shows success message', async () => {
      await goToSuccess();

      expect(screen.getByText('Recovery Phrase Saved')).toBeInTheDocument();
      expect(screen.getByText(/your account is now protected/i)).toBeInTheDocument();
    });

    it('shows "Done" button on success step', async () => {
      await goToSuccess();

      expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
    });

    it('calls onSuccess when done button is clicked', async () => {
      const onSuccess = vi.fn();
      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} onSuccess={onSuccess} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've written it down/i })).toBeInTheDocument();
      });

      await navigateToSuccessWithDefaults(user);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /done/i }));

      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('does not show back button on success step', async () => {
      await goToSuccess();

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });
  });

  describe('Recovery crypto material save', () => {
    const setupForCryptoSaveTest = renderAndCompleteFlow;

    it('sends both halves of the regenerated phrase, and nothing phrase-derived', async () => {
      await setupForCryptoSaveTest();

      expect(mockSaveRecoveryMaterial).toHaveBeenCalledTimes(1);
      const [, material] = mockSaveRecoveryMaterial.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(material).toEqual({
        recoveryPublicKey: toBase64(mockRecoveryPublicKey),
        recoveryWrappedPrivateKey: toBase64(mockRecoveryWrappedPrivateKey),
      });
      expect(material).not.toHaveProperty('phraseSalt');
      expect(material).not.toHaveProperty('phraseVerifier');
      expect(material).not.toHaveProperty('encryptedDekPhrase');
    });

    it('shows success step after the gated save succeeds', async () => {
      await setupForCryptoSaveTest();

      await waitFor(() => {
        expect(screen.getByText('Recovery Phrase Saved')).toBeInTheDocument();
      });
    });

    it('shows error when the gated save throws', async () => {
      mockSaveRecoveryMaterial.mockRejectedValueOnce(new Error('Network error'));

      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've written it down/i })).toBeInTheDocument();
      });

      await navigateToPasswordStep(user);
      await submitPassword(user);

      await waitFor(() => {
        expect(screen.getByText(/failed to save recovery/i)).toBeInTheDocument();
      });
    });

    it('shows the mapped copy, not the exception text, when regenerateRecoveryPhrase rejects', async () => {
      mockRegenerateRecoveryPhrase.mockRejectedValueOnce(new Error('Crypto failure'));

      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/failed to generate recovery phrase/i)).toBeInTheDocument();
      });
      expect(screen.queryByText('Crypto failure')).not.toBeInTheDocument();
    });

    it('shows the mapped copy when regenerateRecoveryPhrase rejects with a non-Error', async () => {
      mockRegenerateRecoveryPhrase.mockRejectedValueOnce('unknown error');

      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/failed to generate recovery phrase/i)).toBeInTheDocument();
      });
    });

    it('shows error when account private key is not available', async () => {
      const { useAuthStore } = await import('@/lib/auth/auth');
      vi.mocked(useAuthStore.getState).mockReturnValueOnce({ privateKey: null } as ReturnType<
        typeof useAuthStore.getState
      >);

      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/failed to save recovery/i)).toBeInTheDocument();
      });
    });
  });

  describe('Modal behavior', () => {
    it('does not render when open is false', () => {
      render(<RecoveryPhraseModal {...defaultProps} open={false} />);

      expect(screen.queryByText('Save your recovery phrase')).not.toBeInTheDocument();
    });

    it('calls regenerateRecoveryPhrase each time modal opens', async () => {
      const { rerender } = render(<RecoveryPhraseModal {...defaultProps} open={false} />);

      rerender(<RecoveryPhraseModal {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(mockRegenerateRecoveryPhrase).toHaveBeenCalled();
      });
    });
  });

  describe('edge cases', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('builds its actions and fields from the published button, field and overlay parts', () => {
      const sources = Object.values(MODAL_SOURCES);

      expect(sources).toHaveLength(1);
      expect(sources[0]).not.toMatch(/\bModalActions\b/);
      expect(sources[0]).not.toMatch(/\bInput\b/);
      expect(sources[0]).not.toMatch(/\buseMobileAutoFocus\b/);
    });

    it('shows a save error when the regenerated material cannot be encoded', async () => {
      // Regeneration yields unusable material, so the save fails while encoding
      // it — before the request is ever built, and so before the endpoint is
      // called. The user sees the mapped copy, never a partial save.
      mockRegenerateRecoveryPhrase.mockResolvedValueOnce({
        recoveryPhrase: 'apple brave candy delta eagle frost globe happy ivory joker kite lemon',
        recoveryWrappedPrivateKey: null,
        recoveryPublicKey: null,
      });
      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've written it down/i })).toBeInTheDocument();
      });

      await navigateToPasswordStep(user);
      await submitPassword(user);

      await waitFor(() => {
        expect(screen.getByText(/failed to save recovery/i)).toBeInTheDocument();
      });
      expect(mockSaveRecoveryMaterial).not.toHaveBeenCalled();
    });

    it('shows a save error when no recovery material was captured', async () => {
      // Regeneration fails after the phrase is on screen, so the material ref
      // is never populated: the phrase renders, the user verifies it, and the
      // save has nothing to send. Throwing on the material read is the one way
      // in — the phrase is set before the ref is, so a later failure leaves a
      // visible phrase with a null ref.
      mockRegenerateRecoveryPhrase.mockResolvedValueOnce({
        recoveryPhrase: 'apple brave candy delta eagle frost globe happy ivory joker kite lemon',
        get recoveryWrappedPrivateKey(): Uint8Array {
          throw new Error('material unavailable');
        },
        recoveryPublicKey: mockRecoveryPublicKey,
      });
      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've written it down/i })).toBeInTheDocument();
      });

      await navigateToPasswordStep(user);
      await submitPassword(user);

      await waitFor(() => {
        expect(screen.getByText(/failed to save recovery/i)).toBeInTheDocument();
      });
      expect(mockSaveRecoveryMaterial).not.toHaveBeenCalled();
    });
  });
});
