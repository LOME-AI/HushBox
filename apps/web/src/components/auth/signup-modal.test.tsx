import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignupModal } from './signup-modal';

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

describe('SignupModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders modal content when open', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByTestId('signup-modal')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<SignupModal open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByTestId('signup-modal')).not.toBeInTheDocument();
  });

  it('displays heading about premium models', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByRole('heading')).toHaveTextContent(/premium/i);
  });

  it('displays description about signing up', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    // Look for the paragraph containing the description
    expect(screen.getByText(/sign up for free to access/i)).toBeInTheDocument();
  });

  it('renders Sign Up button', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: /sign up/i })).toBeInTheDocument();
  });

  it('renders Maybe Later button', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: /maybe later/i })).toBeInTheDocument();
  });

  it('navigates to signup page when Sign Up is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<SignupModal open={true} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: /sign up/i }));

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/signup' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes modal when Maybe Later is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<SignupModal open={true} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: /maybe later/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('closes modal on Escape key', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<SignupModal open={true} onOpenChange={onOpenChange} />);

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('includes model name in message when modelName is provided', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} modelName="GPT-4 Turbo" />);

    expect(screen.getByText(/GPT-4 Turbo/)).toBeInTheDocument();
  });

  it('shows generic message when modelName is not provided', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    // Check for the specific description text (not the heading)
    expect(screen.getByText(/access premium models including/i)).toBeInTheDocument();
  });

  describe('variant="rate-limit"', () => {
    it('shows rate limit heading instead of premium heading', () => {
      render(<SignupModal open={true} onOpenChange={vi.fn()} variant="rate-limit" />);

      expect(screen.getByRole('heading')).toHaveTextContent(/continue chatting/i);
      expect(screen.queryByText(/premium/i)).not.toBeInTheDocument();
    });

    it('shows rate limit description about free messages', () => {
      render(<SignupModal open={true} onOpenChange={vi.fn()} variant="rate-limit" />);

      expect(screen.getByText(/5 free messages/i)).toBeInTheDocument();
      expect(screen.getByText(/save your conversation history/i)).toBeInTheDocument();
    });

    it('ignores modelName when variant is rate-limit', () => {
      render(
        <SignupModal open={true} onOpenChange={vi.fn()} variant="rate-limit" modelName="GPT-4" />
      );

      expect(screen.queryByText(/GPT-4/)).not.toBeInTheDocument();
    });
  });
});
