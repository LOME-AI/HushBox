import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsLayout, type SettingsNavItem } from './settings-layout';

// Mock useIsMobile hook (default to desktop)
vi.mock('../hooks/use-is-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

import { useIsMobile } from '../hooks/use-is-mobile';

const mockUseIsMobile = vi.mocked(useIsMobile);

const navItems: SettingsNavItem[] = [
  { value: 'general', label: 'General' },
  { value: 'accessibility', label: 'Accessibility' },
  { value: 'privacy', label: 'Privacy' },
];

const defaultProps = {
  navItems,
  activeValue: 'general',
  onChange: vi.fn(),
  children: <div data-testid="content-area">Settings content</div>,
};

describe('SettingsLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseIsMobile.mockReturnValue(false);
  });

  describe('desktop layout', () => {
    it('renders a <nav> landmark', () => {
      render(<SettingsLayout {...defaultProps} />);
      expect(screen.getByRole('navigation')).toBeInTheDocument();
    });

    it('renders a <main> landmark for content', () => {
      render(<SettingsLayout {...defaultProps} />);
      expect(screen.getByRole('main')).toBeInTheDocument();
    });

    it('renders all nav items as buttons', () => {
      render(<SettingsLayout {...defaultProps} />);
      const nav = screen.getByRole('navigation');
      for (const item of navItems) {
        expect(within(nav).getByRole('button', { name: item.label })).toBeInTheDocument();
      }
    });

    it('renders children inside the main content area', () => {
      render(<SettingsLayout {...defaultProps} />);
      const main = screen.getByRole('main');
      expect(within(main).getByTestId('content-area')).toBeInTheDocument();
    });

    it('marks the active nav item with aria-current="page"', () => {
      render(<SettingsLayout {...defaultProps} activeValue="accessibility" />);
      const activeButton = screen.getByRole('button', { name: 'Accessibility' });
      expect(activeButton).toHaveAttribute('aria-current', 'page');
    });

    it('does not mark inactive nav items with aria-current', () => {
      render(<SettingsLayout {...defaultProps} activeValue="accessibility" />);
      const inactiveButton = screen.getByRole('button', { name: 'General' });
      expect(inactiveButton).not.toHaveAttribute('aria-current');
    });

    it('calls onChange with the value when a nav item is clicked', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<SettingsLayout {...defaultProps} onChange={onChange} />);

      await user.click(screen.getByRole('button', { name: 'Privacy' }));
      expect(onChange).toHaveBeenCalledExactlyOnceWith('privacy');
    });

    it('renders the pageTitle when provided', () => {
      render(<SettingsLayout {...defaultProps} pageTitle="Settings" />);
      expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    });

    it('does not render a heading when pageTitle is not provided', () => {
      render(<SettingsLayout {...defaultProps} />);
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    });

    it('renders icons next to nav item labels when provided', () => {
      const itemsWithIcons: SettingsNavItem[] = [
        { value: 'general', label: 'General', icon: <span data-testid="icon-general">G</span> },
        {
          value: 'accessibility',
          label: 'Accessibility',
          icon: <span data-testid="icon-a11y">A</span>,
        },
      ];
      render(<SettingsLayout {...defaultProps} navItems={itemsWithIcons} activeValue="general" />);
      expect(screen.getByTestId('icon-general')).toBeInTheDocument();
      expect(screen.getByTestId('icon-a11y')).toBeInTheDocument();
    });

    it('uses sidebar nav width on desktop', () => {
      render(<SettingsLayout {...defaultProps} />);
      const nav = screen.getByRole('navigation');
      // Desktop nav uses ~240px width
      expect(nav.className).toMatch(/\bw-60\b/);
    });

    it('applies accent styling to the active nav item', () => {
      render(<SettingsLayout {...defaultProps} activeValue="accessibility" />);
      const activeButton = screen.getByRole('button', { name: 'Accessibility' });
      // Active state uses bg-accent (without `hover:` prefix) for the always-on background
      expect(activeButton.className).toMatch(/(?:^|\s)bg-accent(?:\s|$)/);
    });

    it('does not apply accent styling to inactive items', () => {
      render(<SettingsLayout {...defaultProps} activeValue="accessibility" />);
      const inactiveButton = screen.getByRole('button', { name: 'General' });
      // Inactive items only get bg-accent on hover, never as a default class
      expect(inactiveButton.className).not.toMatch(/(?:^|\s)bg-accent(?:\s|$)/);
    });
  });

  describe('mobile layout', () => {
    beforeEach(() => {
      mockUseIsMobile.mockReturnValue(true);
    });

    it('renders a <nav> landmark on mobile', () => {
      render(<SettingsLayout {...defaultProps} />);
      expect(screen.getByRole('navigation')).toBeInTheDocument();
    });

    it('renders a <main> landmark on mobile', () => {
      render(<SettingsLayout {...defaultProps} />);
      expect(screen.getByRole('main')).toBeInTheDocument();
    });

    it('renders nav items as horizontal pill buttons on mobile', () => {
      render(<SettingsLayout {...defaultProps} />);
      const nav = screen.getByRole('navigation');
      for (const item of navItems) {
        expect(within(nav).getByRole('button', { name: item.label })).toBeInTheDocument();
      }
    });

    it('marks the active nav item with aria-current="page" on mobile', () => {
      render(<SettingsLayout {...defaultProps} activeValue="privacy" />);
      const activeButton = screen.getByRole('button', { name: 'Privacy' });
      expect(activeButton).toHaveAttribute('aria-current', 'page');
    });

    it('calls onChange when a mobile tab is clicked', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<SettingsLayout {...defaultProps} onChange={onChange} />);

      await user.click(screen.getByRole('button', { name: 'Accessibility' }));
      expect(onChange).toHaveBeenCalledExactlyOnceWith('accessibility');
    });

    it('renders children below tab strip in main', () => {
      render(<SettingsLayout {...defaultProps} />);
      const main = screen.getByRole('main');
      expect(within(main).getByTestId('content-area')).toBeInTheDocument();
    });

    it('renders the pageTitle when provided on mobile', () => {
      render(<SettingsLayout {...defaultProps} pageTitle="Settings" />);
      expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    });

    it('makes the mobile tab strip horizontally scrollable and sticky', () => {
      render(<SettingsLayout {...defaultProps} />);
      const nav = screen.getByRole('navigation');
      expect(nav.className).toMatch(/overflow-x-auto/);
      expect(nav.className).toMatch(/sticky/);
    });

    it('applies accent styling to the active mobile pill', () => {
      render(<SettingsLayout {...defaultProps} activeValue="privacy" />);
      const activeButton = screen.getByRole('button', { name: 'Privacy' });
      expect(activeButton.className).toMatch(/(?:^|\s)bg-accent(?:\s|$)/);
    });

    it('renders icons in mobile pills when provided', () => {
      const itemsWithIcons: SettingsNavItem[] = [
        { value: 'general', label: 'General', icon: <span data-testid="m-icon-general">G</span> },
      ];
      render(<SettingsLayout {...defaultProps} navItems={itemsWithIcons} activeValue="general" />);
      expect(screen.getByTestId('m-icon-general')).toBeInTheDocument();
    });
  });
});
