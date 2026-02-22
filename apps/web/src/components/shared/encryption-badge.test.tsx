import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EncryptionBadge } from './encryption-badge';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipContent: ({ children, ...props }: { children: React.ReactNode }) => (
      <div data-testid="tooltip-content" {...props}>
        {children}
      </div>
    ),
  };
});

describe('EncryptionBadge', () => {
  it('renders the shield icon', () => {
    render(<EncryptionBadge isAuthenticated={true} />);

    expect(screen.getByTestId('encryption-badge')).toBeInTheDocument();
    expect(screen.getByTestId('encryption-badge-icon')).toBeInTheDocument();
  });

  it('applies green color to the icon', () => {
    render(<EncryptionBadge isAuthenticated={true} />);

    const icon = screen.getByTestId('encryption-badge-icon');
    expect(icon).toHaveClass('text-green-500');
  });

  it('renders tooltip trigger with aria-hidden icon', () => {
    render(<EncryptionBadge isAuthenticated={false} />);

    const icon = screen.getByTestId('encryption-badge-icon');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders as inline-flex container', () => {
    render(<EncryptionBadge isAuthenticated={true} />);

    const badge = screen.getByTestId('encryption-badge');
    expect(badge).toHaveClass('inline-flex', 'items-center');
  });

  it('displays ZDR messaging in tooltip for authenticated users', () => {
    render(<EncryptionBadge isAuthenticated={true} />);

    expect(screen.getByText(/never store or train/i)).toBeInTheDocument();
  });

  it('displays ZDR messaging in tooltip for unauthenticated users', () => {
    render(<EncryptionBadge isAuthenticated={false} />);

    expect(screen.getByText(/never store or train/i)).toBeInTheDocument();
  });
});
