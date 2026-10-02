import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { toast } from '@hushbox/ui';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import { TEST_IDS } from '@hushbox/shared';
import { MINUTE_MS, TEST_DAY_START, freezeClock } from '@hushbox/shared/test-time';
import { queryClient as appQueryClient } from '@/providers/query-provider';
import { renderRoute, renderWithProviders } from '@/test-utils/render';
import { Route } from './verify';

// Keep the real router (createFileRoute must run for the route file); mock only
// the navigation/link/search hooks the page touches.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useSearch: vi.fn(() => ({ token: 'test-token' })),
    useNavigate: vi.fn(() => vi.fn()),
    Link: ({
      children,
      to,
      className,
    }: {
      children: React.ReactNode;
      to: string;
      className?: string;
    }): React.JSX.Element => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

interface VerifyPostArgs {
  json: { token: string };
}

const postMock = vi.fn(
  (_args: VerifyPostArgs): Promise<Response> => new Promise<Response>(() => {})
);

interface ResendPostArgs {
  json: { email: string };
}

const resendPostMock = vi.fn(
  (_args: ResendPostArgs): Promise<Response> => Promise.resolve(Response.json({ success: true }))
);

// Only the transport is faked, so the real `fetchJson` and the retry policy
// see exactly what a dropped connection or a refusal hands them.
vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    client: {
      auth: {
        'verify-email': {
          $post: (args: VerifyPostArgs) => postMock(args),
          resend: { $post: (args: ResendPostArgs) => resendPostMock(args) },
        },
      },
    },
  };
});

// Keep the real @hushbox/ui (providers depend on it); override only `toast`.
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    toast: {
      success: vi.fn(),
      error: vi.fn(),
    },
  };
});

const TRANSPORT_FAILURE_COPY = 'Email verification failed. Please try again or request a new link.';

function neverSettles(): Promise<Response> {
  return new Promise<Response>(() => {});
}

describe('VerifyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMock.mockImplementation(neverSettles);
    vi.mocked(useSearch).mockReturnValue({ token: 'test-token' });
  });

  it('shows loading state initially', () => {
    renderRoute(Route);

    expect(screen.getByText(/verifying/i)).toBeInTheDocument();
  });

  it('sends the token from the link', async () => {
    renderRoute(Route);

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith({ json: { token: 'test-token' } });
    });
  });

  it('shows success state on successful verification', async () => {
    postMock.mockResolvedValue(Response.json({ success: true }));

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /email verified/i })).toBeInTheDocument();
    });
    expect(toast.success).toHaveBeenCalledWith('Email verified successfully!');
    expect(screen.getByRole('link', { name: /continue to login/i })).toHaveAttribute(
      'href',
      '/login'
    );
  });

  it('shows error state on verification failure', async () => {
    postMock.mockResolvedValue(
      Response.json({ code: 'INVALID_VERIFICATION_TOKEN' }, { status: 400 })
    );

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });
    expect(
      screen.getByText('This verification link is invalid or has expired.')
    ).toBeInTheDocument();
    expect(screen.getByText(/log in to receive a new verification email/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to login/i })).toHaveAttribute('href', '/login');
  });

  it('shows the verification failure copy when a refusal carries no readable body', async () => {
    postMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });
    expect(screen.getByText(TRANSPORT_FAILURE_COPY)).toBeInTheDocument();
  });
});

describe('VerifyPage under the app-wide mutation policy', () => {
  let randomSpy: MockInstance<() => number>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearch).mockReturnValue({ token: 'test-token' });
    // The policy's backoff is full jitter, a random draw below its ceiling;
    // drawing zero keeps every retry the policy makes and none of its waits.
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  function renderUnderAppPolicy(): void {
    const client = new QueryClient({
      defaultOptions: { mutations: { ...appQueryClient.getDefaultOptions().mutations } },
    });
    const Component = Route.options.component!;
    renderWithProviders(
      <QueryClientProvider client={client}>
        <Component />
      </QueryClientProvider>
    );
  }

  it('re-sends the verification when the connection drops before any response', async () => {
    postMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(Response.json({ success: true }));

    renderUnderAppPolicy();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /email verified/i })).toBeInTheDocument();
    });
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it('sends exactly three times while the connection stays down', async () => {
    postMock.mockRejectedValue(new TypeError('Failed to fetch'));

    renderUnderAppPolicy();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });
    expect(postMock).toHaveBeenCalledTimes(3);
  });

  it('shows the verification failure copy once the connection has stayed down', async () => {
    postMock.mockRejectedValue(new TypeError('Failed to fetch'));

    renderUnderAppPolicy();

    await waitFor(() => {
      expect(screen.getByText(TRANSPORT_FAILURE_COPY)).toBeInTheDocument();
    });
    expect(screen.getByText(/log in to receive a new verification email/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to login/i })).toBeInTheDocument();
  });
});

/**
 * StrictMode at the root, as the app mounts it. Nested under a provider
 * wrapper, React does not double-invoke the page's effects.
 */
function renderUnderRootStrictMode(): void {
  const Component = Route.options.component!;
  render(
    <React.StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <Component />
      </QueryClientProvider>
    </React.StrictMode>
  );
}

/**
 * A send starts only after the mutation's own awaited steps, so a count of
 * sends read before every mutation has settled cannot see one being made.
 */
async function waitForMutationsToSettle(client: QueryClient): Promise<void> {
  await waitFor(() => {
    expect(client.isMutating()).toBe(0);
  });
}

function holdAnswer(): (response: Response) => void {
  let answer: (response: Response) => void = () => {};
  postMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      })
  );
  return (response) => {
    answer(response);
  };
}

describe('VerifyPage idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMock.mockResolvedValue(Response.json({ success: true }));
    vi.mocked(useSearch).mockReturnValue({ token: 'idempotency-token' });
  });

  it('sends the verification at most once when the effect runs twice for the same token', async () => {
    renderUnderRootStrictMode();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /email verified/i })).toBeInTheDocument();
    });

    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('still transitions to the success state when the effect runs twice', async () => {
    renderUnderRootStrictMode();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /email verified/i })).toBeInTheDocument();
    });
    expect(toast.success).toHaveBeenCalledWith('Email verified successfully!');
  });

  it('shows success for an answer that arrives after the effect has run twice', async () => {
    const answer = holdAnswer();
    renderUnderRootStrictMode();
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });

    answer(Response.json({ success: true }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /email verified/i })).toBeInTheDocument();
    });
  });

  it('shows the failure for a refusal that arrives after the effect has run twice', async () => {
    const answer = holdAnswer();
    renderUnderRootStrictMode();
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });

    answer(Response.json({ code: 'INVALID_VERIFICATION_TOKEN' }, { status: 400 }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });
    expect(
      screen.getByText('This verification link is invalid or has expired.')
    ).toBeInTheDocument();
  });

  it('does not re-verify a token it has already sent for when it reappears', async () => {
    // Guard on the sent-token ref: the effect re-runs when the token flips to a
    // falsy value and back, but the ref still holds the original token, so the
    // second appearance short-circuits without a second send.
    const Component = Route.options.component!;
    const { rerender, queryClient } = renderWithProviders(<Component />);

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });

    vi.mocked(useSearch).mockReturnValue({ token: undefined });
    rerender(<Component />);

    vi.mocked(useSearch).mockReturnValue({ token: 'idempotency-token' });
    rerender(<Component />);
    await waitForMutationsToSettle(queryClient);

    expect(postMock).toHaveBeenCalledTimes(1);
  });
});

describe('VerifyPage once its verification has settled', () => {
  // Past TanStack's default mutation garbage-collection window.
  const PAST_DEFAULT_COLLECTION = 6 * MINUTE_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearch).mockReturnValue({ token: 'settled-token' });
    freezeClock(TEST_DAY_START, { shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('still shows success after the default collection window has passed', async () => {
    postMock.mockResolvedValue(Response.json({ success: true }));
    renderUnderRootStrictMode();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /email verified/i })).toBeInTheDocument();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEFAULT_COLLECTION);
    });

    expect(screen.getByRole('heading', { name: /email verified/i })).toBeInTheDocument();
  });

  it('still shows the failure after the default collection window has passed', async () => {
    postMock.mockResolvedValue(
      Response.json({ code: 'INVALID_VERIFICATION_TOKEN' }, { status: 400 })
    );
    renderUnderRootStrictMode();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEFAULT_COLLECTION);
    });

    expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
  });
});

describe('VerifyPage without token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearch).mockReturnValue({ token: undefined });
  });

  it('shows error when no token provided', () => {
    renderRoute(Route);

    expect(screen.getByText(/no verification token/i)).toBeInTheDocument();
  });

  it('sends nothing when no token provided', async () => {
    postMock.mockImplementation(() => Promise.resolve(Response.json({ success: true })));

    const { queryClient } = renderRoute(Route);
    await waitForMutationsToSettle(queryClient);

    expect(postMock).not.toHaveBeenCalled();
  });
});

describe('VerifyPage body text colour', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMock.mockImplementation(neverSettles);
  });

  it('paints the missing-token paragraph in the muted foreground colour', () => {
    vi.mocked(useSearch).mockReturnValue({ token: undefined });

    renderRoute(Route);

    const paragraph = screen.getByText(/the verification link appears to be invalid/i);
    expect(paragraph).toHaveClass('text-muted-foreground');
    expect(paragraph).not.toHaveClass('text-muted');
  });

  it('paints the loading paragraph in the muted foreground colour', () => {
    vi.mocked(useSearch).mockReturnValue({ token: 'test-token' });

    renderRoute(Route);

    const paragraph = screen.getByText(/please wait while we verify your email address/i);
    expect(paragraph).toHaveClass('text-muted-foreground');
    expect(paragraph).not.toHaveClass('text-muted');
  });
});

describe('VerifyPage without token: resend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearch).mockReturnValue({ token: undefined });
    resendPostMock.mockImplementation(() => Promise.resolve(Response.json({ success: true })));
  });

  it('sets the title in the auth title role', () => {
    renderRoute(Route);

    expect(screen.getByRole('heading', { level: 1, name: 'No verification token' })).toHaveClass(
      'text-auth-title'
    );
  });

  it('sets the explanation in muted body-size text', () => {
    renderRoute(Route);

    expect(screen.getByText(/the verification link appears to be invalid/i)).toHaveClass(
      'text-muted-foreground',
      'text-base'
    );
  });

  it('offers an Email field for the address', () => {
    renderRoute(Route);

    const field = screen.getByLabelText('Email');
    expect(field).toHaveAttribute('type', 'email');
    expect(field).toHaveAttribute('autocomplete', 'email');
  });

  it('offers the resend as a full-width extra-large submit button', () => {
    renderRoute(Route);

    const button = screen.getByTestId(TEST_IDS.resendButton);
    expect(button).toHaveTextContent('Resend verification email');
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toHaveAttribute('data-size', 'xl');
    expect(button).toHaveAttribute('data-block');
  });

  it('shows the sign-up email error for an invalid address', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    expect(await screen.findByText('Please enter a valid email')).toBeInTheDocument();
  });

  it('sends nothing for an invalid address', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderRoute(Route);

    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByTestId(TEST_IDS.resendButton));
    await waitForMutationsToSettle(queryClient);

    expect(resendPostMock).not.toHaveBeenCalled();
  });

  it('sends nothing for an empty address', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderRoute(Route);

    await user.click(screen.getByTestId(TEST_IDS.resendButton));
    await waitForMutationsToSettle(queryClient);

    expect(resendPostMock).not.toHaveBeenCalled();
  });

  it('shows no email error before a send is tried', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText('Email'), 'not-an-email');

    expect(screen.queryByText('Please enter a valid email')).not.toBeInTheDocument();
  });

  it('sends one request with a valid address', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    await screen.findByTestId(TEST_IDS.resendFeedback);
    expect(resendPostMock).toHaveBeenCalledTimes(1);
    expect(resendPostMock).toHaveBeenCalledWith({ json: { email: 'alice@example.com' } });
  });

  it('sends from the field with Enter', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText('Email'), 'alice@example.com{Enter}');

    await screen.findByTestId(TEST_IDS.resendFeedback);
    expect(resendPostMock).toHaveBeenCalledTimes(1);
  });

  it('confirms the sent email', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    expect(await screen.findByTestId(TEST_IDS.resendFeedback)).toHaveTextContent(
      'Verification email sent.'
    );
  });

  it('announces the feedback in a polite live region', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    const feedback = await screen.findByTestId(TEST_IDS.resendFeedback);
    expect(feedback).toHaveAttribute('role', 'status');
    expect(feedback).toHaveAttribute('aria-live', 'polite');
  });

  it("shows the server's refusal", async () => {
    resendPostMock.mockImplementation(() =>
      Promise.resolve(Response.json({ code: 'RATE_LIMITED' }, { status: 429 }))
    );
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    const feedback = await screen.findByTestId(TEST_IDS.resendFeedback);
    expect(feedback).toHaveTextContent('Too many attempts. Try again in a moment.');
    expect(feedback).toHaveClass('text-destructive');
  });

  it('counts the cooldown on the button after a send', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    await screen.findByTestId(TEST_IDS.resendFeedback);
    const button = screen.getByTestId(TEST_IDS.resendButton);
    expect(button).toHaveTextContent('Resend verification email (60s)');
    expect(button).toBeDisabled();
  });
});

describe('VerifyPage while verifying', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMock.mockImplementation(neverSettles);
    vi.mocked(useSearch).mockReturnValue({ token: 'test-token' });
    useA11yStore.getState().reset();
  });

  afterEach(() => {
    act(() => {
      useA11yStore.getState().reset();
    });
  });

  it("draws the foundation's spinner", () => {
    const { container } = renderRoute(Route);

    expect(container.querySelector('[data-slot="spinner"]')).not.toBeNull();
  });

  it('holds the spinner still while motion is stopped', () => {
    act(() => {
      useA11yStore.getState().update({ stopAnimations: true });
    });

    const { container } = renderRoute(Route);

    expect(container.querySelector('.animate-spin')).toBeNull();
  });
});
