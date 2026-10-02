import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NOTICE_COPY, REFUSAL_CODES, TEST_IDS } from '@hushbox/shared';
import { Swatch } from '@hushbox/ui/marks';
import { modelSwatch } from '@/lib/utils/model-color';
import { useUIModalsStore } from '@/stores/ui/modals';
import { SignupModal } from './signup-modal';
import type { RefusalCode } from '@hushbox/shared';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  // Stands in for the router's link: the caller's onClick runs, then the router navigates.
  Link: ({
    to,
    onClick,
    className,
    children,
  }: {
    to: string;
    onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
    className?: string;
    children: React.ReactNode;
  }): React.JSX.Element => (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
        mockNavigate({ to });
      }}
    >
      {children}
    </a>
  ),
}));

const REFUSED_MODEL_ID = 'anthropic/claude-sonnet-4.5';

function modalElement(): HTMLElement {
  return screen.getByTestId(TEST_IDS.signupModal);
}

describe('SignupModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIModalsStore.setState({ premiumModelId: undefined });
  });

  describe('the pitch frame', () => {
    it('draws the HushBox mark', () => {
      render(<SignupModal open={true} onOpenChange={vi.fn()} />);

      expect(modalElement().querySelector('img')).not.toBeNull();
    });

    it('holds exactly one heading', () => {
      render(
        <SignupModal
          open={true}
          onOpenChange={vi.fn()}
          modelName="Claude Sonnet 4.5"
          reason="premium_requires_account"
        />
      );

      expect(within(modalElement()).getAllByRole('heading')).toHaveLength(1);
    });

    it("draws the refused model's own swatch on the model line", () => {
      useUIModalsStore.setState({ premiumModelId: REFUSED_MODEL_ID });
      const { container: expected } = render(<Swatch swatch={modelSwatch(REFUSED_MODEL_ID)} />);
      render(
        <SignupModal
          open={true}
          onOpenChange={vi.fn()}
          modelName="Claude Sonnet 4.5"
          reason="premium_requires_account"
        />
      );

      const swatch = modalElement().querySelector('[data-slot="swatch"]');
      expect(swatch?.className).toBe(expected.querySelector('[data-slot="swatch"]')?.className);
    });

    it('sets the swatch and the model name on one line', () => {
      useUIModalsStore.setState({ premiumModelId: REFUSED_MODEL_ID });
      render(
        <SignupModal
          open={true}
          onOpenChange={vi.fn()}
          modelName="Claude Sonnet 4.5"
          reason="premium_requires_account"
        />
      );

      const swatch = modalElement().querySelector('[data-slot="swatch"]');
      expect(swatch?.parentElement).toHaveTextContent(/^Claude Sonnet 4\.5$/);
    });

    it('names the model without a swatch when no id reached the store', () => {
      render(
        <SignupModal
          open={true}
          onOpenChange={vi.fn()}
          modelName="Claude Sonnet 4.5"
          reason="premium_requires_account"
        />
      );

      expect(within(modalElement()).getByText('Claude Sonnet 4.5')).toBeInTheDocument();
      expect(modalElement().querySelector('[data-slot="swatch"]')).toBeNull();
    });

    it('draws no model line when no model is named', () => {
      useUIModalsStore.setState({ premiumModelId: REFUSED_MODEL_ID });
      render(<SignupModal open={true} onOpenChange={vi.fn()} reason="premium_requires_account" />);

      expect(modalElement().querySelector('[data-slot="swatch"]')).toBeNull();
    });

    it("gives the sentence the refusal's own copy", () => {
      render(
        <SignupModal
          open={true}
          onOpenChange={vi.fn()}
          modelName="Claude Sonnet 4.5"
          reason="premium_requires_account"
        />
      );

      const sentence = within(modalElement()).getByText(NOTICE_COPY.premium_requires_account.cause);
      expect(sentence.textContent).toBe(NOTICE_COPY.premium_requires_account.cause);
    });

    it('lists the three sign-up points', () => {
      render(<SignupModal open={true} onOpenChange={vi.fn()} />);

      const points = within(modalElement()).getAllByRole('listitem');
      expect(points.map((point) => point.textContent)).toEqual([
        '\u2713Privacy by design',
        '\u2713Access GPT, Claude, Gemini & more',
        '\u2713Your data is never sold or trained on',
      ]);
    });

    it('puts Maybe Later before Sign Up', () => {
      render(<SignupModal open={true} onOpenChange={vi.fn()} />);

      const later = screen.getByRole('button', { name: 'Maybe Later' });
      const signUp = screen.getByRole('button', { name: 'Sign Up' });
      expect(later.compareDocumentPosition(signUp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('offers Log in after the buttons', () => {
      render(<SignupModal open={true} onOpenChange={vi.fn()} />);

      const signUp = screen.getByRole('button', { name: 'Sign Up' });
      const logIn = screen.getByRole('link', { name: 'Log in' });
      expect(logIn.closest('p')).toHaveTextContent('Already have an account? Log in');
      expect(signUp.compareDocumentPosition(logIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('closes the dialog when Log in is clicked', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(<SignupModal open={true} onOpenChange={onOpenChange} />);

      await user.click(screen.getByRole('link', { name: 'Log in' }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('opens the login page when Log in is clicked', async () => {
      const user = userEvent.setup();
      render(<SignupModal open={true} onOpenChange={vi.fn()} />);

      const logIn = screen.getByRole('link', { name: 'Log in' });
      await user.click(logIn);

      expect(logIn).toHaveAttribute('href', '/login');
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' });
    });
  });

  it('renders modal content when open', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByTestId(TEST_IDS.signupModal)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<SignupModal open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByTestId(TEST_IDS.signupModal)).not.toBeInTheDocument();
  });

  it('displays heading about premium models', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    const modal = screen.getByTestId(TEST_IDS.signupModal);
    expect(within(modal).getByRole('heading')).toHaveTextContent(/premium/i);
  });

  it('displays description about signing up', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

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

  it('keeps the premium sentence naming the model when no reason reached the modal', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} modelName="GPT-4 Turbo" />);

    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'DIV' &&
          element.textContent ===
            'GPT-4 Turbo is a premium model. Sign up for free to access the most powerful AI models available.'
      )
    ).toBeInTheDocument();
  });

  it('shows generic message when modelName is not provided', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText(/access premium models including/i)).toBeInTheDocument();
  });

  describe('refusal reasons', () => {
    /** The refusals the premium heading is true of; every other code is derived from the union. */
    const premiumCodes: readonly RefusalCode[] = [
      'premium_requires_account',
      'premium_requires_credit',
    ];
    const otherCodes = REFUSAL_CODES.filter((code) => !premiumCodes.includes(code));

    const headingOf = (): HTMLElement =>
      within(screen.getByTestId(TEST_IDS.signupModal)).getByRole('heading');

    it.each([...REFUSAL_CODES])(
      'describes why the row was refused when the reason is %s',
      (reason) => {
        render(
          <SignupModal open={true} onOpenChange={vi.fn()} modelName="GPT-4 Turbo" reason={reason} />
        );

        expect(screen.getByText(NOTICE_COPY[reason].cause)).toBeInTheDocument();
      }
    );

    it.each([...premiumCodes])('keeps the premium heading when the reason is %s', (reason) => {
      render(
        <SignupModal open={true} onOpenChange={vi.fn()} modelName="GPT-4 Turbo" reason={reason} />
      );

      expect(headingOf()).toHaveTextContent('Unlock Premium Models');
    });

    it.each(otherCodes)(
      'heads the modal with the account title when the reason is %s',
      (reason) => {
        render(
          <SignupModal open={true} onOpenChange={vi.fn()} modelName="GPT-4 Turbo" reason={reason} />
        );

        expect(headingOf()).toHaveTextContent('Create your account');
      }
    );

    it('shows the model the visitor clicked beside the reason', () => {
      render(
        <SignupModal
          open={true}
          onOpenChange={vi.fn()}
          modelName="GPT-4 Turbo"
          reason="insufficient_funds"
        />
      );

      expect(within(modalElement()).getByText('GPT-4 Turbo')).toBeInTheDocument();
    });

    it('renders no model label when no model reached the modal', () => {
      render(<SignupModal open={true} onOpenChange={vi.fn()} reason="insufficient_funds" />);

      const description = screen.getByText(NOTICE_COPY.insufficient_funds.cause).closest('div');
      expect(description?.textContent).toBe(NOTICE_COPY.insufficient_funds.cause);
    });
  });

  describe('multi-model variant', () => {
    it('renders the multi-model modal with its own title and message', () => {
      render(<SignupModal open={true} onOpenChange={vi.fn()} variant="multi-model" />);

      const modal = screen.getByTestId(TEST_IDS.multiModelSignupModal);
      expect(within(modal).getByRole('heading')).toHaveTextContent(/compare multiple models/i);
      expect(
        screen.getByText(/send your message to multiple ai models at once/i)
      ).toBeInTheDocument();
    });

    it('draws no model line, whatever the store holds', () => {
      useUIModalsStore.setState({ premiumModelId: REFUSED_MODEL_ID });
      render(<SignupModal open={true} onOpenChange={vi.fn()} variant="multi-model" />);

      const modal = screen.getByTestId(TEST_IDS.multiModelSignupModal);
      expect(modal.querySelector('[data-slot="swatch"]')).toBeNull();
    });

    it('takes the same frame: the mark, the points and Log in', () => {
      render(<SignupModal open={true} onOpenChange={vi.fn()} variant="multi-model" />);

      const modal = screen.getByTestId(TEST_IDS.multiModelSignupModal);
      expect(modal.querySelector('img')).not.toBeNull();
      expect(within(modal).getAllByRole('listitem')).toHaveLength(3);
      expect(within(modal).getByRole('link', { name: 'Log in' })).toBeInTheDocument();
    });
  });
});
