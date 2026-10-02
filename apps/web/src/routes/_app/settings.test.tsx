import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { installThemeTokens } from '@/test-utils/theme-tokens.js';
import { PageShell } from '@/components/shared/page-shell';
import { renderRoute, renderWithProviders } from '@/test-utils/render';
import { Route } from './settings';
import type * as React from 'react';
import type { SettingsSectionId } from '@/hooks/ui/use-section-in-view';

/** The auth store's instruction-read status, which the store does not export. */
type InstructionsStatus = 'pending' | 'absent' | 'present';

// vi.hoisted values are available inside vi.mock factories (hoisted above imports)
const { mockChangePassword, mockUseAuthStore, useAuthStoreMock, mockAuthStoreState } = vi.hoisted(
  () => {
    const mockChangePasswordFunction = vi.fn();
    const mockUseAuthStoreFunction = vi.fn();

    // Default state returned by useAuthStore.getState() — RecoveryPhraseModal uses this
    const state = {
      user: null as {
        id: string;
        email: string;
        username: string;
        emailVerified: boolean;
        totpEnabled: boolean;
        hasAcknowledgedPhrase: boolean;
      } | null,
      privateKey: new Uint8Array(32),
      customInstructions: null as string | null,
      customInstructionsStatus: 'absent' as InstructionsStatus,
      isLoading: false,
      isAuthenticated: true,
      setUser: vi.fn(),
      setPrivateKey: vi.fn(),
      setCustomInstructions: vi.fn(),
      setLoading: vi.fn(),
      clear: vi.fn(),
    };

    // useAuthStore must support both selector calls and .getState()
    const mock = Object.assign(
      (selector: (s: typeof state) => unknown) => mockUseAuthStoreFunction(selector),
      { getState: () => state }
    );

    return {
      mockChangePassword: mockChangePasswordFunction,
      mockUseAuthStore: mockUseAuthStoreFunction,
      mockAuthStoreState: state,
      useAuthStoreMock: mock,
    };
  }
);

const { mockDisable2FAInit, mockDisable2FAFinish, mockSaveRecoveryMaterial } = vi.hoisted(() => ({
  mockDisable2FAInit: vi.fn(),
  mockDisable2FAFinish: vi.fn(),
  mockSaveRecoveryMaterial: vi.fn(),
}));

// The predicate comes from the real module rather than a second copy here: a
// mock that re-implemented it would agree with production only until one of
// them changed.
vi.mock('@/lib/auth/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth')>();
  return {
    selectInstructionsReadUnresolved: actual.selectInstructionsReadUnresolved,
    requireAuth: vi.fn().mockImplementation(() => Promise.resolve()),
    changePassword: (...args: unknown[]) => mockChangePassword(...args),
    useAuthStore: useAuthStoreMock,
    useSession: vi.fn(() => ({ data: null, isPending: false })),
    disable2FAInit: (...args: unknown[]) => mockDisable2FAInit(...args),
    disable2FAFinish: (...args: unknown[]) => mockDisable2FAFinish(...args),
    saveRecoveryMaterial: (...args: unknown[]) => mockSaveRecoveryMaterial(...args),
  };
});

vi.mock('@/hooks/billing/billing', () => ({
  useBalance: vi.fn(() => ({ data: undefined, isLoading: false })),
}));

// The mailing list row's own test exercises the real hooks; here the page test only needs
// stable states to assert placement.
vi.mock('@/hooks/newsletter/use-newsletter-settings', () => ({
  useNewsletterSettings: vi.fn(() => ({
    isPending: false,
    isError: false,
    data: { subscribed: false },
  })),
  useUpdateNewsletterSettings: vi.fn(() => ({ isPending: false, mutate: vi.fn() })),
}));

vi.mock('@/hooks/auth/use-delete-account', () => ({
  useDeleteAccountInit: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDeleteAccountFinish: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock('@/hooks/auth/auth-mutations', () => ({
  useChangePassword: vi.fn(() => ({
    mutateAsync: async (variables: {
      currentPassword: string;
      newPassword: string;
    }): Promise<{ success: boolean; error?: string }> => {
      const result = (await mockChangePassword(
        variables.currentPassword,
        variables.newPassword
      )) as { success: boolean; error?: string };
      if (!result.success) throw new Error(result.error ?? 'CHANGE_PASSWORD_FAILED');
      return result;
    },
    isPending: false,
  })),
}));

// RecoveryPhraseModal imports getApiUrl from @/lib/api/api
vi.mock('@/lib/api/api', () => ({
  getApiUrl: vi.fn(() => 'http://localhost:8787'),
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: vi.fn(() => false),
  };
});

vi.mock('@/components/settings/custom-instructions-modal', () => ({
  CustomInstructionsModal: ({
    open,
    onSuccess,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
  }) =>
    open ? (
      <div data-testid="custom-instructions-modal">
        <button onClick={onSuccess}>Mock Save</button>
      </div>
    ) : null,
}));

const { mockChangePasswordSubmitResult } = vi.hoisted(() => ({
  mockChangePasswordSubmitResult: vi.fn(),
}));

// Stub the change-password modal so the page's onSuccess/onSubmit callbacks are
// reachable from clicks. It still renders "Change Password" text so the
// modal-opens assertion (getAllByText('Change Password')[1]) keeps working.
vi.mock('@/components/auth/change-password-modal', () => ({
  ChangePasswordModal: ({
    open,
    onSuccess,
    onSubmit,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
    onSubmit: (data: {
      currentPassword: string;
      newPassword: string;
    }) => Promise<{ success: boolean; error?: string }>;
  }) =>
    open ? (
      <div data-testid="change-password-modal-stub">
        <span>Change Password</span>
        <button data-testid="cp-onsuccess" onClick={onSuccess}>
          success
        </button>
        <button
          data-testid="cp-onsubmit"
          onClick={() => {
            void (async () => {
              const result = await onSubmit({ currentPassword: 'cur', newPassword: 'new' });
              mockChangePasswordSubmitResult(result);
            })();
          }}
        >
          submit
        </button>
      </div>
    ) : null,
}));

vi.mock('@/components/settings/delete-account-modal', () => ({
  DeleteAccountModal: ({ open }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? <div data-testid="delete-account-modal-stub">Delete account flow</div> : null,
}));

vi.mock('@hushbox/crypto', () => ({
  regenerateRecoveryPhrase: vi.fn(() =>
    Promise.resolve({
      recoveryPhrase: 'apple brave candy delta eagle frost globe happy ivory joker kite lemon',
      recoveryWrappedPrivateKey: new Uint8Array(64),
      recoveryPublicKey: new Uint8Array(32),
    })
  ),
  toBase64: vi.fn(() => 'base64-encoded-key'),
}));

// The device's permission reading is the notifications group's own test's to settle; left
// pending here, it lands no update after a page test has finished.
vi.mock('@/lib/notification-channel', () => ({
  notificationChannel: {
    getPermissionState: (): Promise<never> => new Promise(() => {}),
    getLastRegistrationOutcome: (): null => null,
    requestPermissionAndRegister: (): Promise<never> => new Promise(() => {}),
    ensureRegistered: (): Promise<never> => new Promise(() => {}),
    unregister: (): Promise<never> => new Promise(() => {}),
  },
}));

// The link row's own test drives it under a router; here the page only places it.
vi.mock('@/components/settings/account-nav', () => ({
  AccountNav: ({ current }: { current: SettingsSectionId }): React.JSX.Element => (
    <nav aria-label="Settings" data-testid={TEST_IDS.settingsSectionNav} data-current={current} />
  ),
}));

const mockOpenExternalPage = vi.fn();
vi.mock('@/capacitor', () => ({
  openExternalPage: (...args: unknown[]) => mockOpenExternalPage(...args),
}));

document.elementFromPoint = vi.fn(() => null);

// The real setup, beside a hidden mark per mounted instance that reads its open state, so a
// test can count the instances the page mounts and see which one a control opens.
vi.mock('@/components/auth/two-factor-setup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/auth/two-factor-setup')>();
  return {
    TwoFactorSetup: (
      props: React.ComponentProps<typeof actual.TwoFactorSetup>
    ): React.JSX.Element => (
      <>
        <span hidden data-two-factor-setup-open={String(props.open)} />
        <actual.TwoFactorSetup {...props} />
      </>
    ),
  };
});

vi.mock('react-qrcode-logo', () => ({
  QRCode: ({ value }: { value: string }) => (
    <div data-testid="qr-code" data-value={value}>
      QR Code Mock
    </div>
  ),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function setMockUser(
  overrides: {
    email?: string;
    emailVerified?: boolean;
    totpEnabled?: boolean;
    hasAcknowledgedPhrase?: boolean;
  } = {}
): void {
  const defaultUser = {
    id: 'user-1',
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
  };
  const user = { ...defaultUser, ...overrides };
  // Update both selector mock and getState().user for direct access
  mockAuthStoreState.user = user;
  mockUseAuthStore.mockImplementation(
    (
      selector: (state: {
        user: typeof user;
        customInstructions: string | null;
        customInstructionsStatus: InstructionsStatus;
      }) => unknown
    ) =>
      selector({
        user,
        customInstructions: mockAuthStoreState.customInstructions,
        customInstructionsStatus: mockAuthStoreState.customInstructionsStatus,
      })
  );
}

const SECTIONS = [
  ['account', 'Account'],
  ['security', 'Security'],
  ['preferences', 'Preferences'],
  ['notifications', 'Notifications'],
  ['legal', 'Legal'],
  ['danger', 'Danger zone'],
] as const;

function content(): HTMLElement {
  return screen.getByTestId(TEST_IDS.settingsContent);
}

/** A settings group, found by its title. */
function group(title: string): HTMLElement {
  const section = within(content())
    .getByRole('heading', { level: 2, name: title })
    .closest('section');
  if (section === null) throw new Error(`the ${title} group has no section`);
  return section;
}

/** A settings row, found by its title. */
function settingsRow(title: string): HTMLElement {
  const row = within(content()).getByText(title).closest<HTMLElement>('[data-settings-row]');
  if (row === null) throw new Error(`the ${title} row is not a settings row`);
  return row;
}

/**
 * Drives the recovery-phrase modal from the word grid to its success screen.
 * The save is gated on an OPAQUE password step-up, so the flow is
 * display → verify → password → success.
 */
async function completeRecoveryPhraseFlow(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /i've written it down/i }));

  await waitFor(() => {
    expect(screen.getByText('Verify Your Phrase')).toBeInTheDocument();
  });

  // Verification indices are pinned to 0, 1, 2 by the getRandomValues spy.
  const inputs = screen.getAllByRole('textbox');
  await user.type(inputs[0]!, 'apple');
  await user.type(inputs[1]!, 'brave');
  await user.type(inputs[2]!, 'candy');

  await user.click(screen.getByRole('button', { name: /verify/i }));

  await waitFor(() => {
    expect(screen.getByText('Confirm Your Password')).toBeInTheDocument();
  });

  await user.type(screen.getByLabelText('Password'), 'mypassword');
  await user.click(screen.getByRole('button', { name: /replace recovery phrase/i }));
}

describe('SettingsPage', () => {
  // The 2FA modal's QR paints to a canvas, so it resolves the brand token off
  // the cascade and refuses an undefined one rather than painting a colour the
  // canvas would ignore.
  let removeThemeTokens: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    removeThemeTokens = installThemeTokens();
    mockDisable2FAInit.mockResolvedValue({
      success: true,
      ke3: [4, 5, 6],
      disable2FASessionId: '00000000-0000-4000-8000-deadbeefdead',
    });
    mockDisable2FAFinish.mockResolvedValue({ success: true });
    mockSaveRecoveryMaterial.mockResolvedValue({ success: true });
    setMockUser();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          secret: 'JBSWY3DPEHPK3PXP',
          totpUri: 'otpauth://totp/test',
        }),
    });
  });

  afterEach(() => {
    removeThemeTokens();
  });

  describe('settled output', () => {
    it('leaves no update to land outside act once the page has rendered', async () => {
      const errors = vi.spyOn(console, 'error');
      renderRoute(Route);

      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });

      const unsettled = errors.mock.calls.filter((call) =>
        String(call[0]).includes('not wrapped in act')
      );
      expect(unsettled).toEqual([]);
    });
  });

  describe('groups', () => {
    it('renders Account, Security, Preferences, Notifications, Legal and Danger zone in that order', () => {
      setMockUser({ totpEnabled: true, hasAcknowledgedPhrase: true });
      renderRoute(Route);

      const titles = within(content())
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent);
      expect(titles).toEqual([
        'Account',
        'Security',
        'Preferences',
        'Notifications',
        'Legal',
        'Danger zone',
      ]);
    });

    it('gives each group the section id the link row jumps to', () => {
      renderRoute(Route);

      for (const [id, title] of SECTIONS) {
        expect(group(title)).toHaveAttribute('id', id);
      }
    });

    it('draws no group in a card', () => {
      renderRoute(Route);

      expect(content().querySelector('[data-slot="card"]')).toBeNull();
    });

    it('describes only the Notifications group', () => {
      renderRoute(Route);

      for (const description of [
        'Your account information',
        'Manage authentication',
        'Customize how AI responds to you',
        'Terms and policies',
      ]) {
        expect(screen.queryByText(description)).not.toBeInTheDocument();
      }
    });

    it('draws no leading icon on any row outside Needs attention', () => {
      setMockUser({ totpEnabled: true, hasAcknowledgedPhrase: true });
      renderRoute(Route);

      // Every icon on the page sits at a row's end: a chevron, a badge's mark, an external link.
      const icons = content().querySelectorAll('svg');
      expect(icons.length).toBeGreaterThan(0);
      for (const icon of icons) {
        expect(icon.closest('[data-settings-trailing]')).not.toBeNull();
      }
    });

    it('pins the settings link row above the groups', () => {
      renderRoute(Route);

      const nav = screen.getByTestId(TEST_IDS.settingsSectionNav);
      expect(nav.closest('[data-page-pinned]')).not.toBeNull();
    });

    it('marks the first section current before any scrolling', () => {
      renderRoute(Route);

      expect(screen.getByTestId(TEST_IDS.settingsSectionNav)).toHaveAttribute(
        'data-current',
        'account'
      );
    });
  });

  describe('needs attention group', () => {
    const PHRASE_TITLE = 'Recovery phrase not saved';
    /**
     * Outlasts the overlay's focus return, which the dialog queues as a zero-delay task when it
     * unmounts, so a landing read after it has survived that return.
     */
    const FOCUS_RETURN_SETTLE_MS = 50;
    const TWO_FACTOR_TITLE = 'Two-factor authentication is off';

    function attention(): HTMLElement {
      return screen.getByTestId(TEST_IDS.needsAttention);
    }

    /** The one mounted two-factor setup's open state, and how many the page mounts. */
    function twoFactorSetups(): string[] {
      return [...document.querySelectorAll<HTMLElement>('[data-two-factor-setup-open]')].map(
        (mark) => mark.dataset['twoFactorSetupOpen'] ?? ''
      );
    }

    /** Lets the next store write reach the page's read, as the real store's subscription does. */
    function storeWritesReachThePage(): void {
      vi.mocked(useAuthStoreMock.getState().setUser).mockImplementationOnce((next: unknown) => {
        setMockUser(next as Parameters<typeof setMockUser>[0]);
      });
    }

    it('opens the page above Account while the phrase is unsaved and two-factor is off', () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      renderRoute(Route);

      const titles = within(content())
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent);
      expect(titles.slice(0, 2)).toEqual(['Needs attention', 'Account']);
    });

    it('carries its test id on the Needs attention group', () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      renderRoute(Route);

      expect(attention()).toContainElement(
        within(content()).getByRole('heading', { level: 2, name: 'Needs attention' })
      );
    });

    it('shows both rows while the phrase is unsaved and two-factor is off', () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      renderRoute(Route);

      expect(within(attention()).getByText(PHRASE_TITLE)).toBeInTheDocument();
      expect(within(attention()).getByText(TWO_FACTOR_TITLE)).toBeInTheDocument();
    });

    it('explains the unsaved recovery phrase in its row', () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: true });
      renderRoute(Route);

      expect(
        within(settingsRow(PHRASE_TITLE)).getByText(
          'If you lose your password, this is your only recovery.'
        )
      ).toBeInTheDocument();
      expect(
        within(settingsRow(PHRASE_TITLE)).getByRole('button', { name: 'Save phrase' })
      ).toBeInTheDocument();
    });

    it('explains two-factor being off in its row', () => {
      setMockUser({ hasAcknowledgedPhrase: true, totpEnabled: false });
      renderRoute(Route);

      expect(
        within(settingsRow(TWO_FACTOR_TITLE)).getByText(
          'A stolen password alone could open your account.'
        )
      ).toBeInTheDocument();
      expect(
        within(settingsRow(TWO_FACTOR_TITLE)).getByRole('button', { name: 'Turn on' })
      ).toBeInTheDocument();
    });

    it('shows only the recovery phrase row while two-factor is on', () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: true });
      renderRoute(Route);

      expect(within(attention()).getByText(PHRASE_TITLE)).toBeInTheDocument();
      expect(within(attention()).queryByText(TWO_FACTOR_TITLE)).not.toBeInTheDocument();
    });

    it('shows only the two-factor row while the phrase is saved', () => {
      setMockUser({ hasAcknowledgedPhrase: true, totpEnabled: false });
      renderRoute(Route);

      expect(within(attention()).getByText(TWO_FACTOR_TITLE)).toBeInTheDocument();
      expect(within(attention()).queryByText(PHRASE_TITLE)).not.toBeInTheDocument();
    });

    it('draws no Needs attention group once the phrase is saved and two-factor is on', () => {
      setMockUser({ hasAcknowledgedPhrase: true, totpEnabled: true });
      renderRoute(Route);

      expect(screen.queryByTestId(TEST_IDS.needsAttention)).not.toBeInTheDocument();
      expect(
        within(content()).queryByRole('heading', { level: 2, name: 'Needs attention' })
      ).not.toBeInTheDocument();
    });

    it('draws no Needs attention group while no user is known', () => {
      mockAuthStoreState.user = null;
      mockUseAuthStore.mockImplementation(
        (
          selector: (state: {
            user: null;
            customInstructions: string | null;
            customInstructionsStatus: InstructionsStatus;
          }) => unknown
        ) => selector({ user: null, customInstructions: null, customInstructionsStatus: 'absent' })
      );
      renderRoute(Route);

      expect(screen.queryByTestId(TEST_IDS.needsAttention)).not.toBeInTheDocument();
    });

    it('leads each row with an icon in the warning tone', () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      renderRoute(Route);

      for (const title of [PHRASE_TITLE, TWO_FACTOR_TITLE]) {
        const icon = settingsRow(title).querySelector('svg');
        expect(icon).toHaveClass('text-warning');
        const position = icon?.compareDocumentPosition(screen.getByText(title)) ?? 0;
        expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });

    it('draws each button full width under its text below 768 and inline from 768', () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      renderRoute(Route);

      for (const [title, action] of [
        [PHRASE_TITLE, 'Save phrase'],
        [TWO_FACTOR_TITLE, 'Turn on'],
      ] as const) {
        const row = settingsRow(title);
        expect(within(row).getByRole('button', { name: action })).toHaveAttribute('data-block');
        expect(row).toHaveClass('flex-wrap', 'md:flex-nowrap');
      }
    });

    it('opens the recovery phrase dialog from Save phrase', async () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(within(attention()).getByRole('button', { name: 'Save phrase' }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.recoveryPhraseModal)).toBeInTheDocument();
      });
    });

    it('opens the two-factor setup from Turn on', async () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(within(attention()).getByRole('button', { name: 'Turn on' }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.twoFactorSetupModal)).toBeInTheDocument();
      });
    });

    it('opens the one two-factor setup the Security row opens', async () => {
      setMockUser({ hasAcknowledgedPhrase: true, totpEnabled: false });
      const user = userEvent.setup();
      renderRoute(Route);
      expect(twoFactorSetups()).toEqual(['false']);

      await user.click(within(attention()).getByRole('button', { name: 'Turn on' }));
      expect(twoFactorSetups()).toEqual(['true']);
      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(twoFactorSetups()).toEqual(['false']);
      });

      await user.click(screen.getByRole('button', { name: 'Two-Factor Authentication' }));
      expect(twoFactorSetups()).toEqual(['true']);
    });

    /** Pins the phrase check to words 1, 2 and 3, which the flow helper types. */
    function pinVerificationIndices(): void {
      let callCount = 0;
      vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
        <T extends ArrayBufferView>(array: T): T => {
          if (array instanceof Uint8Array && array.length === 1) {
            array[0] = callCount++;
          }
          return array;
        }
      );
    }

    /** Saves the phrase from the group's Save phrase, through to Done. */
    async function savePhraseFromGroup(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      pinVerificationIndices();
      await user.click(within(attention()).getByRole('button', { name: 'Save phrase' }));
      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.wordGrid)).toBeInTheDocument();
      });
      await completeRecoveryPhraseFlow(user);
      await user.click(await screen.findByRole('button', { name: /done/i }));
    }

    /** Opens the setup with `open`, then finishes it: Get Started, Continue, the code, Done. */
    async function finishTwoFactorSetup(
      user: ReturnType<typeof userEvent.setup>,
      open: HTMLElement
    ): Promise<void> {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              secret: 'JBSWY3DPEHPK3PXP',
              totpUri: 'otpauth://totp/test',
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      await user.click(open);
      await user.click(await screen.findByRole('button', { name: /get started/i }));
      await user.click(await screen.findByRole('button', { name: /continue/i }));
      await user.click(screen.getByTestId(TEST_IDS.otpInput));
      await user.keyboard('123456');
      await user.click(await screen.findByRole('button', { name: /done/i }));
    }

    it('removes the recovery phrase row once the phrase is saved, without a reload', async () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      storeWritesReachThePage();
      const user = userEvent.setup();
      renderRoute(Route);

      await savePhraseFromGroup(user);

      await waitFor(() => {
        expect(within(attention()).queryByText(PHRASE_TITLE)).not.toBeInTheDocument();
      });
      expect(within(attention()).getByText(TWO_FACTOR_TITLE)).toBeInTheDocument();
    }, 15_000);

    it('removes the two-factor row once setup finishes, without a reload', async () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      storeWritesReachThePage();
      const user = userEvent.setup();
      renderRoute(Route);

      await finishTwoFactorSetup(
        user,
        within(attention()).getByRole('button', { name: 'Turn on' })
      );

      await waitFor(() => {
        expect(within(attention()).queryByText(TWO_FACTOR_TITLE)).not.toBeInTheDocument();
      });
      expect(within(attention()).getByText(PHRASE_TITLE)).toBeInTheDocument();
    }, 15_000);

    it('lands focus on the Security Recovery Phrase row once the phrase is saved from the group', async () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      storeWritesReachThePage();
      const user = userEvent.setup();
      renderRoute(Route);

      await savePhraseFromGroup(user);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Recovery Phrase' })).toHaveFocus();
      });
    }, 15_000);

    it('lands focus on the Security two-factor row once setup finishes from Turn on', async () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      storeWritesReachThePage();
      const user = userEvent.setup();
      renderRoute(Route);

      await finishTwoFactorSetup(
        user,
        within(attention()).getByRole('button', { name: 'Turn on' })
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Two-Factor Authentication' })).toHaveFocus();
      });
    }, 15_000);

    it('keeps the landing once the dialog has finished closing', async () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      storeWritesReachThePage();
      const user = userEvent.setup();
      renderRoute(Route);

      await finishTwoFactorSetup(
        user,
        within(attention()).getByRole('button', { name: 'Turn on' })
      );
      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.twoFactorSetupModal)).not.toBeInTheDocument();
      });
      await new Promise((resolve) => {
        setTimeout(resolve, FOCUS_RETURN_SETTLE_MS);
      });

      expect(screen.getByRole('button', { name: 'Two-Factor Authentication' })).toHaveFocus();
    }, 15_000);

    it('returns focus to Turn on when the setup closes from the group unfinished', async () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      const user = userEvent.setup();
      renderRoute(Route);
      const turnOn = within(attention()).getByRole('button', { name: 'Turn on' });

      await user.click(turnOn);
      await screen.findByTestId(TEST_IDS.twoFactorSetupModal);
      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(turnOn).toHaveFocus();
      });
    });

    it('returns focus to Save phrase when the phrase dialog closes from the group unfinished', async () => {
      setMockUser({ hasAcknowledgedPhrase: false, totpEnabled: false });
      const user = userEvent.setup();
      renderRoute(Route);
      const savePhrase = within(attention()).getByRole('button', { name: 'Save phrase' });

      await user.click(savePhrase);
      await screen.findByTestId(TEST_IDS.recoveryPhraseModal);
      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(savePhrase).toHaveFocus();
      });
    });
  });

  describe('rendering', () => {
    it('shows the security group', () => {
      renderRoute(Route);

      expect(group('Security')).toBeInTheDocument();
    });

    it('shows change password option', () => {
      renderRoute(Route);

      const row = screen.getByRole('button', { name: 'Change Password' });
      expect(row).toHaveAccessibleDescription('Update your account password');
    });

    it('shows two-factor authentication option', () => {
      renderRoute(Route);

      expect(
        within(group('Security')).getByRole('button', { name: 'Two-Factor Authentication' })
      ).toBeInTheDocument();
    });

    it('shows recovery phrase option with description', () => {
      renderRoute(Route);

      expect(screen.getByText('Recovery Phrase')).toBeInTheDocument();
      expect(screen.getByText('Protect from forgetting your password')).toBeInTheDocument();
    });

    it('shows "Add an extra layer of security" when 2FA is disabled', () => {
      setMockUser({ totpEnabled: false });
      renderRoute(Route);

      expect(screen.getByText('Add an extra layer of security')).toBeInTheDocument();
    });

    it('shows "Manage your authentication security" when 2FA is enabled', () => {
      setMockUser({ totpEnabled: true });
      renderRoute(Route);

      expect(screen.getByText('Manage your authentication security')).toBeInTheDocument();
    });
  });

  describe('legal group', () => {
    it('opens the Terms of Service through the external page opener', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(within(group('Legal')).getByRole('link', { name: 'Terms of Service' }));

      expect(mockOpenExternalPage).toHaveBeenCalledWith('/terms');
    });

    it('opens the Privacy Policy through the external page opener', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(within(group('Legal')).getByRole('link', { name: 'Privacy Policy' }));

      expect(mockOpenExternalPage).toHaveBeenCalledWith('/privacy');
    });

    it('marks both legal rows as external', () => {
      renderRoute(Route);

      for (const link of within(group('Legal')).getAllByRole('link')) {
        expect(link.querySelector('[data-settings-trailing] svg')).not.toBeNull();
      }
    });

    it('shows no effective-date line', () => {
      renderRoute(Route);

      expect(screen.queryByText(/Effective:/)).not.toBeInTheDocument();
    });
  });

  describe('account group', () => {
    it('shows the account email as the Email row description', () => {
      setMockUser({ email: 'user@hushbox.ai' });
      renderRoute(Route);

      const row = settingsRow('Email');
      expect(within(row).getByText('user@hushbox.ai')).toBeInTheDocument();
    });

    it('shows the username in its own row', () => {
      renderRoute(Route);

      const row = settingsRow('Username');
      expect(within(group('Account')).getByText('Username')).toBeInTheDocument();
      expect(within(row).getByText('test_user')).toBeInTheDocument();
    });

    it('marks the Verified badge with a check', () => {
      setMockUser({ emailVerified: true });
      renderRoute(Route);

      expect(
        within(settingsRow('Email')).getByText('Verified').querySelector('svg')
      ).not.toBeNull();
    });

    it('shows Verified badge when email is verified', () => {
      setMockUser({ emailVerified: true });
      renderRoute(Route);

      expect(screen.getByText('Verified')).toBeInTheDocument();
    });

    it('shows Not verified badge when email is not verified', () => {
      setMockUser({ emailVerified: false });
      renderRoute(Route);

      expect(screen.getByText('Not verified')).toBeInTheDocument();
    });
  });

  describe('mailing list row', () => {
    it('renders the mailing list switch in Preferences, after Custom Instructions', () => {
      renderRoute(Route);

      const preferences = group('Preferences');
      const toggle = within(preferences).getByTestId(TEST_IDS.settingsMailingListToggle);
      const instructions = within(preferences).getByRole('button', {
        name: 'Custom Instructions',
      });
      expect(
        instructions.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });
  });

  describe('notifications group', () => {
    it('renders the notification settings as the Notifications group', () => {
      renderRoute(Route);

      expect(group('Notifications')).toHaveAttribute('id', 'notifications');
    });
  });

  describe('status badges', () => {
    // Each badge sits inside its row's button, where the E2E page object reads it.
    function badgeIn(rowName: string, label: string): HTMLElement {
      return within(screen.getByRole('button', { name: rowName })).getByText(label);
    }

    it('shows Enabled badge when 2FA is enabled', () => {
      setMockUser({ totpEnabled: true });
      renderRoute(Route);

      expect(badgeIn('Two-Factor Authentication', 'Enabled')).toBeInTheDocument();
    });

    it('shows Disabled badge when 2FA is disabled', () => {
      setMockUser({ totpEnabled: false });
      renderRoute(Route);

      expect(badgeIn('Two-Factor Authentication', 'Disabled')).toBeInTheDocument();
    });

    it('shows Enabled badge for recovery phrase when acknowledged', () => {
      setMockUser({ hasAcknowledgedPhrase: true });
      renderRoute(Route);

      expect(badgeIn('Recovery Phrase', 'Enabled')).toBeInTheDocument();
    });

    it('shows Disabled badge for recovery phrase when not acknowledged', () => {
      setMockUser({ hasAcknowledgedPhrase: false });
      renderRoute(Route);

      expect(badgeIn('Recovery Phrase', 'Disabled')).toBeInTheDocument();
    });
  });

  describe('change password modal', () => {
    it('opens change password modal when button is clicked', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Change Password' }));

      await waitFor(() => {
        expect(screen.getAllByText('Change Password')[1]).toBeInTheDocument();
      });
    });
  });

  describe('two-factor authentication modal', () => {
    it('opens 2FA setup modal when button is clicked', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Two-Factor Authentication' }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.twoFactorSetupModal)).toBeInTheDocument();
      });
    });

    it('updates user state with totpEnabled after 2FA success', async () => {
      // Setup: first call returns TOTP data, second call is verify success
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              secret: 'JBSWY3DPEHPK3PXP',
              totpUri: 'otpauth://totp/test',
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Two-Factor Authentication' }));

      // Click "Get Started" to trigger TOTP fetch and transition to scan step
      await user.click(await screen.findByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(screen.getByText('Scan QR Code')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /continue/i }));

      // Enter code (auto-submits on complete)
      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /done/i }));

      await waitFor(() => {
        expect(useAuthStoreMock.getState().setUser).toHaveBeenCalledWith(
          expect.objectContaining({ totpEnabled: true })
        );
      });
    }, 15_000);

    it('opens 2FA disable modal when button is clicked and 2FA is enabled', async () => {
      setMockUser({ totpEnabled: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Two-Factor Authentication' }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.disableTwoFactorModal)).toBeInTheDocument();
      });
    });

    it('updates user state with totpEnabled false after 2FA disable success', async () => {
      setMockUser({ totpEnabled: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Two-Factor Authentication' }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.disableTwoFactorModal)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });

      // Enter OTP (auto-submits on 6 digits)
      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(useAuthStoreMock.getState().setUser).toHaveBeenCalledWith(
          expect.objectContaining({ totpEnabled: false })
        );
      });
    }, 15_000);
  });

  describe('preferences group', () => {
    it('renders Custom Instructions setting item', () => {
      renderRoute(Route);

      expect(
        screen.getByRole('button', { name: 'Custom Instructions' })
      ).toHaveAccessibleDescription(
        expect.stringContaining("Tell the AI about yourself and how you'd like it to respond")
      );
    });

    it('shows Active badge when custom instructions are set', () => {
      mockUseAuthStore.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          user: mockAuthStoreState.user,
          customInstructions: 'Be concise',
          customInstructionsStatus: 'present',
        })
      );

      renderRoute(Route);

      expect(
        within(screen.getByRole('button', { name: 'Custom Instructions' })).getByText('Active')
      ).toBeInTheDocument();
    });

    it('shows Not set badge once the read has landed and this account stores none', () => {
      mockUseAuthStore.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          user: mockAuthStoreState.user,
          customInstructions: null,
          customInstructionsStatus: 'absent',
        })
      );

      renderRoute(Route);

      expect(
        within(screen.getByRole('button', { name: 'Custom Instructions' })).getByText('Not set')
      ).toBeInTheDocument();
    });

    it('shows the loading badge rather than Not set while the read is unresolved', () => {
      mockUseAuthStore.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          user: mockAuthStoreState.user,
          customInstructions: null,
          customInstructionsStatus: 'pending',
        })
      );

      renderRoute(Route);

      expect(
        within(screen.getByRole('button', { name: 'Custom Instructions' })).getByText('Loading...')
      ).toBeInTheDocument();
      expect(screen.queryByText('Not set')).not.toBeInTheDocument();
    });

    it('opens custom instructions modal when clicked', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Custom Instructions' }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.customInstructionsModal)).toBeInTheDocument();
      });
    });
  });

  describe('danger zone', () => {
    it('renders the Danger zone sentence in its group', () => {
      renderRoute(Route);
      expect(
        within(group('Danger zone')).getByText(
          'Permanently delete your account and all associated data.'
        )
      ).toBeInTheDocument();
    });

    it('draws Delete Account as a block destructive button in the Danger zone', () => {
      renderRoute(Route);
      const trigger = within(group('Danger zone')).getByTestId(TEST_IDS.deleteAccountTrigger);
      expect(trigger).toHaveAttribute('data-variant', 'destructive');
      expect(trigger).toHaveAttribute('data-block');
    });

    it('renders a Delete account button in the Danger zone group', () => {
      renderRoute(Route);
      expect(screen.getByTestId(TEST_IDS.deleteAccountTrigger)).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.deleteAccountTrigger)).toHaveTextContent(
        /^Delete Account$/
      );
    });

    it('opens the DeleteAccountModal when the Delete account button is clicked', async () => {
      const user = userEvent.setup();
      renderRoute(Route);
      expect(screen.queryByTestId('delete-account-modal-stub')).not.toBeInTheDocument();

      await user.click(screen.getByTestId(TEST_IDS.deleteAccountTrigger));

      await waitFor(() => {
        expect(screen.getByTestId('delete-account-modal-stub')).toBeInTheDocument();
      });
    });
  });

  describe('recovery phrase flow', () => {
    it('opens recovery phrase modal directly when user has no phrase', async () => {
      setMockUser({ hasAcknowledgedPhrase: false });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Recovery Phrase' }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.recoveryPhraseModal)).toBeInTheDocument();
      });
    });

    it('shows confirmation modal when user already has a phrase', async () => {
      setMockUser({ hasAcknowledgedPhrase: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Recovery Phrase' }));

      await waitFor(() => {
        expect(screen.getByText('Regenerate Recovery Phrase?')).toBeInTheDocument();
        expect(
          screen.getByText(
            'You already have a recovery phrase. A new one stops the old phrase from opening your account, but does not revoke a copy of your encryption key that someone already made.'
          )
        ).toBeInTheDocument();
      });
    });

    it('closes confirmation modal when Cancel is clicked', async () => {
      setMockUser({ hasAcknowledgedPhrase: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Recovery Phrase' }));

      await waitFor(() => {
        expect(screen.getByText('Regenerate Recovery Phrase?')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByText('Regenerate Recovery Phrase?')).not.toBeInTheDocument();
      });
    });

    it('updates user state with hasAcknowledgedPhrase after recovery phrase success', async () => {
      // Mock crypto.getRandomValues for deterministic verification indices (0, 1, 2)
      let callCount = 0;
      vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
        <T extends ArrayBufferView>(array: T): T => {
          if (array instanceof Uint8Array && array.length === 1) {
            array[0] = callCount++;
          }
          return array;
        }
      );

      setMockUser({ hasAcknowledgedPhrase: false });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Recovery Phrase' }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.wordGrid)).toBeInTheDocument();
      });

      await completeRecoveryPhraseFlow(user);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /done/i }));

      await waitFor(() => {
        expect(useAuthStoreMock.getState().setUser).toHaveBeenCalledWith(
          expect.objectContaining({ hasAcknowledgedPhrase: true })
        );
      });
    }, 15_000);

    it('opens recovery phrase modal when Generate New is clicked', async () => {
      setMockUser({ hasAcknowledgedPhrase: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Recovery Phrase' }));

      await waitFor(() => {
        expect(screen.getByText('Regenerate Recovery Phrase?')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /generate new/i }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.recoveryPhraseModal)).toBeInTheDocument();
      });
    });
  });

  describe('route guard', () => {
    it('gates the route on authentication in beforeLoad', async () => {
      const { requireAuth } = await import('@/lib/auth/auth');
      const beforeLoad = Route.options.beforeLoad as (() => Promise<void>) | undefined;
      expect(beforeLoad).toBeDefined();

      await beforeLoad!();

      expect(requireAuth).toHaveBeenCalledTimes(1);
    });
  });

  describe('custom instructions success', () => {
    it('closes the custom instructions modal on success', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Custom Instructions' }));
      expect(screen.getByTestId(TEST_IDS.customInstructionsModal)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /mock save/i }));

      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.customInstructionsModal)).not.toBeInTheDocument();
      });
    });
  });

  describe('change password', () => {
    async function openChangePassword(): Promise<void> {
      const user = userEvent.setup();
      renderRoute(Route);
      await user.click(screen.getByRole('button', { name: 'Change Password' }));
      await waitFor(() => {
        expect(screen.getByTestId('change-password-modal-stub')).toBeInTheDocument();
      });
    }

    it('closes the modal on success', async () => {
      const user = userEvent.setup();
      await openChangePassword();

      await user.click(screen.getByTestId('cp-onsuccess'));

      await waitFor(() => {
        expect(screen.queryByTestId('change-password-modal-stub')).not.toBeInTheDocument();
      });
    });

    it('returns success when the change-password mutation resolves', async () => {
      mockChangePassword.mockResolvedValue({ success: true });
      const user = userEvent.setup();
      await openChangePassword();

      await user.click(screen.getByTestId('cp-onsubmit'));

      await waitFor(() => {
        expect(mockChangePasswordSubmitResult).toHaveBeenCalledWith({ success: true });
      });
      expect(mockChangePassword).toHaveBeenCalledWith('cur', 'new');
    });

    it('returns the error message when the mutation throws an Error', async () => {
      mockChangePassword.mockResolvedValue({ success: false, error: 'Wrong password' });
      const user = userEvent.setup();
      await openChangePassword();

      await user.click(screen.getByTestId('cp-onsubmit'));

      await waitFor(() => {
        expect(mockChangePasswordSubmitResult).toHaveBeenCalledWith({
          success: false,
          error: 'Wrong password',
        });
      });
    });

    it('returns a bare failure when the mutation rejects with a non-Error', async () => {
      mockChangePassword.mockRejectedValue('boom');
      const user = userEvent.setup();
      await openChangePassword();

      await user.click(screen.getByTestId('cp-onsubmit'));

      await waitFor(() => {
        expect(mockChangePasswordSubmitResult).toHaveBeenCalledWith({ success: false });
      });
    });
  });

  describe('auth-state races on modal success', () => {
    // The three success handlers read useAuthStore.getState().user at completion
    // and only call setUser when it is present. Nulling the store user right
    // before completion (e.g. a concurrent logout) exercises the guarded
    // no-op arm without the store user ever being written.
    it('skips the 2FA-enable user update when the store user vanished', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ secret: 'JBSWY3DPEHPK3PXP', totpUri: 'otpauth://totp/test' }),
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });

      setMockUser({ totpEnabled: false });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Two-Factor Authentication' }));
      await user.click(await screen.findByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(screen.getByText('Scan QR Code')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /continue/i }));

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
      });

      // Concurrent logout: the store user is gone by the time success fires.
      mockAuthStoreState.user = null;
      await user.click(screen.getByRole('button', { name: /done/i }));

      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.twoFactorSetupModal)).not.toBeInTheDocument();
      });
      expect(useAuthStoreMock.getState().setUser).not.toHaveBeenCalled();
    }, 15_000);

    it('skips the 2FA-disable user update when the store user vanished', async () => {
      setMockUser({ totpEnabled: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Two-Factor Authentication' }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.disableTwoFactorModal)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });

      mockAuthStoreState.user = null;
      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(mockDisable2FAFinish).toHaveBeenCalled();
      });
      expect(useAuthStoreMock.getState().setUser).not.toHaveBeenCalled();
    }, 15_000);

    it('skips the recovery-phrase user update when the store user vanished', async () => {
      let callCount = 0;
      vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
        <T extends ArrayBufferView>(array: T): T => {
          if (array instanceof Uint8Array && array.length === 1) {
            array[0] = callCount++;
          }
          return array;
        }
      );

      setMockUser({ hasAcknowledgedPhrase: false });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: 'Recovery Phrase' }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.wordGrid)).toBeInTheDocument();
      });

      await completeRecoveryPhraseFlow(user);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
      });

      mockAuthStoreState.user = null;
      await user.click(screen.getByRole('button', { name: /done/i }));

      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.recoveryPhraseModal)).not.toBeInTheDocument();
      });
      expect(useAuthStoreMock.getState().setUser).not.toHaveBeenCalled();
    }, 15_000);
  });

  describe('signed-out shell', () => {
    it('renders defensively when no user is present', () => {
      mockAuthStoreState.user = null;
      mockUseAuthStore.mockImplementation(
        (
          selector: (state: {
            user: null;
            customInstructions: string | null;
            customInstructionsStatus: InstructionsStatus;
          }) => unknown
        ) => selector({ user: null, customInstructions: null, customInstructionsStatus: 'absent' })
      );

      renderRoute(Route);

      // user?.emailVerified is undefined -> "Not verified"; user?.totpEnabled
      // ?? false -> Disabled; both exercise the null-user optional chains.
      expect(screen.getByText('Not verified')).toBeInTheDocument();
      expect(screen.getByText('Add an extra layer of security')).toBeInTheDocument();
    });
  });
});

describe('/_app/settings page header', () => {
  function renderInShell(): void {
    const Page = Route.options.component;
    if (Page === undefined) throw new Error('the route has no component');
    renderWithProviders(
      <PageShell>
        <Page />
      </PageShell>
    );
  }

  it('renders its title as the one h1, in the page shell header', () => {
    renderInShell();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Settings');
    expect(document.querySelector('header')).toContainElement(heading);
  });

  it('draws no theme toggle of its own', () => {
    renderRoute(Route);

    expect(screen.queryByTestId(TEST_IDS.themeToggle)).not.toBeInTheDocument();
  });
});
