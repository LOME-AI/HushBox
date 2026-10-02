import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { setLinkGuestAuth, clearLinkGuestAuth } from '@/lib/auth/link-guest-auth';
import { EncryptionBadge } from './encryption-badge';

const ENCRYPTED_HINT =
  'Encrypted. Not even we can read your messages. We only partner with AI providers that never store or train on your data.';
const ACCOUNTLESS_HINT =
  'We only partner with AI providers that never store or train on your data. Sign up to save encrypted chats';

/** Radix mirrors the open hint into a hidden `role="tooltip"` node; that node is the hint's text. */
async function openHintText(): Promise<string> {
  const hint = await screen.findByRole('tooltip');
  return hint.textContent.replaceAll(/\s+/g, ' ').trim();
}

describe('EncryptionBadge', () => {
  afterEach(() => {
    clearLinkGuestAuth();
  });

  describe('reach', () => {
    it('takes a tab stop and shows its hint when Tab reaches it', async () => {
      const user = userEvent.setup();
      render(<EncryptionBadge isAuthenticated={true} />);

      await user.tab();

      expect(screen.getByTestId(TEST_IDS.encryptionBadge)).toHaveFocus();
      expect(await openHintText()).toBe(ENCRYPTED_HINT);
    });

    it('shows its hint on hover', async () => {
      const user = userEvent.setup();
      render(<EncryptionBadge isAuthenticated={true} />);

      await user.hover(screen.getByTestId(TEST_IDS.encryptionBadge));

      expect(await openHintText()).toBe(ENCRYPTED_HINT);
    });

    it('closes its hint on Escape', async () => {
      const user = userEvent.setup();
      render(<EncryptionBadge isAuthenticated={true} />);
      await user.tab();
      await screen.findByRole('tooltip');

      await user.keyboard('{Escape}');

      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });

  describe('the shield', () => {
    it('is not described by the same text that names it while the hint is open', async () => {
      const user = userEvent.setup();
      render(<EncryptionBadge isAuthenticated={true} />);

      await user.tab();
      await screen.findByRole('tooltip');

      expect(screen.getByTestId(TEST_IDS.encryptionBadge)).not.toHaveAccessibleDescription(
        ENCRYPTED_HINT
      );
    });

    it('keeps the encryption badge test id on the focusable image', () => {
      render(<EncryptionBadge isAuthenticated={true} />);

      expect(screen.getByRole('img', { name: ENCRYPTED_HINT })).toBe(
        screen.getByTestId(TEST_IDS.encryptionBadge)
      );
    });

    it('hides the glyph from assistive technology', () => {
      render(<EncryptionBadge isAuthenticated={true} />);

      expect(screen.getByTestId(TEST_IDS.encryptionBadgeIcon)).toHaveAttribute(
        'aria-hidden',
        'true'
      );
    });

    it('draws the glyph in the success token', () => {
      render(<EncryptionBadge isAuthenticated={true} />);

      expect(screen.getByTestId(TEST_IDS.encryptionBadgeIcon)).toHaveClass('text-success');
    });
  });

  describe('an account holder', () => {
    it('is named by the encrypted hint', () => {
      render(<EncryptionBadge isAuthenticated={true} />);

      expect(screen.getByRole('img', { name: ENCRYPTED_HINT })).toBeInTheDocument();
    });
  });

  // The accountless wording is what any caller gets by passing `isAuthenticated={false}`
  // while no link key is held, which is how the shared reply page selects it.
  describe('a visitor holding neither an account nor a link key', () => {
    it('is named by the accountless hint', () => {
      render(<EncryptionBadge isAuthenticated={false} />);

      expect(screen.getByRole('img', { name: ACCOUNTLESS_HINT })).toBeInTheDocument();
    });

    it('reads the accountless hint when it opens', async () => {
      const user = userEvent.setup();
      render(<EncryptionBadge isAuthenticated={false} />);

      await user.tab();

      expect(await openHintText()).toBe(ACCOUNTLESS_HINT);
    });

    it('finds no link inside the hint', async () => {
      const user = userEvent.setup();
      render(<EncryptionBadge isAuthenticated={false} />);

      await user.tab();
      await screen.findByRole('tooltip');

      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });
  });

  describe('a link guest, whose conversation is encrypted like any other', () => {
    it('is named by the encrypted hint', () => {
      setLinkGuestAuth('link-public-key');

      render(<EncryptionBadge isAuthenticated={false} />);

      expect(screen.getByRole('img', { name: ENCRYPTED_HINT })).toBeInTheDocument();
    });

    it('reads the encrypted hint, with no invitation to sign up', async () => {
      setLinkGuestAuth('link-public-key');
      const user = userEvent.setup();
      render(<EncryptionBadge isAuthenticated={false} />);

      await user.tab();

      expect(await openHintText()).toBe(ENCRYPTED_HINT);
    });
  });
});
