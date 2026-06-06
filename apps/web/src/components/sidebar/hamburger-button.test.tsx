import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';
import { HamburgerButton } from './hamburger-button';

describe('HamburgerButton', () => {
  beforeEach(() => {
    useUIStore.setState({ mobileSidebarOpen: false });
  });

  it('renders hamburger button', () => {
    render(<HamburgerButton />);
    expect(screen.getByTestId(TEST_IDS.hamburgerButton)).toBeInTheDocument();
  });

  it('has accessible label', () => {
    render(<HamburgerButton />);
    expect(screen.getByRole('button', { name: /open menu/i })).toBeInTheDocument();
  });

  it('opens mobile sidebar when clicked', async () => {
    const user = userEvent.setup();
    render(<HamburgerButton />);

    await user.click(screen.getByTestId(TEST_IDS.hamburgerButton));

    expect(useUIStore.getState().mobileSidebarOpen).toBe(true);
  });

  it('has md:hidden class for mobile-only visibility', () => {
    render(<HamburgerButton />);
    expect(screen.getByTestId(TEST_IDS.hamburgerButton)).toHaveClass('md:hidden');
  });
});
