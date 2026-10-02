import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { AccountButton } from './account-button';

const ALICE = { name: 'Alice', balance: '$12.48' };

describe('AccountButton', () => {
  describe('signed in', () => {
    it("shows the account's initial in the avatar", () => {
      render(<AccountButton account={ALICE} collapsed={false} />);
      const avatar = screen
        .getByTestId(TEST_IDS.accountButton)
        .querySelector('[data-slot="avatar"]');
      expect(avatar).toHaveTextContent('A');
    });

    it('shows the name', () => {
      render(<AccountButton account={ALICE} collapsed={false} />);
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    it('sets the balance in mono', () => {
      render(<AccountButton account={ALICE} collapsed={false} />);
      expect(screen.getByText('$12.48')).toHaveClass('font-mono');
    });

    it('draws the up-down chevrons', () => {
      render(<AccountButton account={ALICE} collapsed={false} />);
      expect(
        screen.getByTestId(TEST_IDS.accountButton).querySelector('svg.lucide-chevrons-up-down')
      ).not.toBeNull();
    });

    it('is named by the account and its balance', () => {
      render(<AccountButton account={ALICE} collapsed={false} />);
      expect(screen.getByRole('button', { name: 'Alice $12.48' })).toBeInTheDocument();
    });
  });

  describe('trial visitor', () => {
    it('shows the person icon in the avatar', () => {
      render(<AccountButton account={null} collapsed={false} />);
      const avatar = screen
        .getByTestId(TEST_IDS.accountButton)
        .querySelector('[data-slot="avatar"]');
      expect(avatar?.querySelector('svg.lucide-user')).not.toBeNull();
    });

    it('shows "Trial User"', () => {
      render(<AccountButton account={null} collapsed={false} />);
      expect(screen.getByRole('button', { name: 'Trial User' })).toBeInTheDocument();
    });

    it('draws a single chevron up', () => {
      render(<AccountButton account={null} collapsed={false} />);
      const button = screen.getByTestId(TEST_IDS.accountButton);
      expect(button.querySelector('svg.lucide-chevron-up')).not.toBeNull();
      expect(button.querySelector('svg.lucide-chevrons-up-down')).toBeNull();
    });
  });

  describe('on the collapsed rail', () => {
    it('keeps the name for assistive technology only', () => {
      render(<AccountButton account={ALICE} collapsed />);
      expect(screen.getByText('Alice')).toHaveClass('sr-only');
    });

    it('leaves out the balance', () => {
      render(<AccountButton account={ALICE} collapsed />);
      expect(screen.queryByText('$12.48')).not.toBeInTheDocument();
    });

    it('leaves out the chevrons', () => {
      render(<AccountButton account={ALICE} collapsed />);
      expect(
        screen.getByTestId(TEST_IDS.accountButton).querySelector('svg.lucide-chevrons-up-down')
      ).toBeNull();
    });

    it('grows to the touch floor on a coarse pointer', () => {
      render(<AccountButton account={ALICE} collapsed />);
      expect(screen.getByTestId(TEST_IDS.accountButton)).toHaveClass('pointer-coarse:size-11');
    });

    it('keeps its square when the rail is narrow', () => {
      render(<AccountButton account={ALICE} collapsed />);
      expect(screen.getByTestId(TEST_IDS.accountButton)).toHaveClass('shrink-0');
    });
  });

  describe('as a menu trigger', () => {
    it('keeps the global focus outline', () => {
      render(<AccountButton account={ALICE} collapsed={false} />);
      const button = screen.getByTestId(TEST_IDS.accountButton);
      expect(button.className).not.toMatch(/(^|\s)(focus-visible:)?outline-(none|hidden)(\s|$)/);
    });

    it('takes keyboard focus', async () => {
      const user = userEvent.setup();
      render(<AccountButton account={ALICE} collapsed={false} />);
      await user.tab();
      expect(screen.getByTestId(TEST_IDS.accountButton)).toHaveFocus();
    });

    it('hands its element to a ref', () => {
      const ref = createRef<HTMLButtonElement>();
      render(<AccountButton ref={ref} account={ALICE} collapsed={false} />);
      expect(ref.current).toBe(screen.getByTestId(TEST_IDS.accountButton));
    });

    it('passes on the props a trigger injects', async () => {
      const onClick = vi.fn();
      const user = userEvent.setup();
      render(<AccountButton account={ALICE} collapsed={false} aria-expanded onClick={onClick} />);
      const button = screen.getByTestId(TEST_IDS.accountButton);
      await user.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'true');
      expect(onClick).toHaveBeenCalledOnce();
    });
  });
});
