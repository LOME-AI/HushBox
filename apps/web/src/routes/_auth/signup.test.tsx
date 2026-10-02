import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PRODUCT_TAGLINE } from '@hushbox/shared';
import { signUp } from '@/lib/auth/auth';
import { renderRoute } from '@/test-utils/render';
import { Route } from './signup';

// Keep the real router (createFileRoute must run for the route file); mock only
// the Link the page renders.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Link: ({ children, to }: { children: React.ReactNode; to: string }): React.JSX.Element => (
      <a href={to}>{children}</a>
    ),
  };
});

// The release stage is a build constant; the getter lets each test pick the stage the page
// reads at render time while every other shared export stays real.
type ReleaseStage = (typeof import('@hushbox/shared'))['RELEASE_STAGE'];
const releaseStage = vi.hoisted((): { current: ReleaseStage } => ({ current: 'stable' }));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    get RELEASE_STAGE(): ReleaseStage {
      return releaseStage.current;
    },
  };
});

vi.mock('@/lib/auth/auth', () => ({
  signUp: {
    email: vi.fn(),
  },
  authClient: {
    resendVerification: vi.fn(),
  },
}));

vi.mock('@/capacitor/platform', () => ({
  isNative: (): boolean => false,
}));

vi.mock('@/capacitor/browser', () => ({
  openExternalPage: vi.fn(),
}));

// `renderRoute` mounts the component outside a RouterProvider, so the router's
// bundled `Route.useSearch` internals have no match to read — spy on the Route
// method, as the other renderRoute tests do.
function setSearch(search: { c?: string }): void {
  vi.spyOn(Route, 'useSearch').mockReturnValue(search);
}

const LEGAL_SENTENCE =
  'By creating an account, you agree to our Terms of Service and Privacy Policy.';

const APPROVED_STEP_COPY = [
  'Welcome to the HushBox beta',
  'Thanks for joining early. You get every new feature the moment it ships, and your feedback shapes what we build next.',
  'Heads up',
  'We ship fast, so expect some downtime and the occasional broken feature. As we build, some features may change for good or disappear entirely.',
  'What never changes',
  "We can't read your messages.",
  'Your purchased credit is never lost to our mistakes.',
  'Join the beta',
  'Read the full beta terms',
] as const;

function legalSentence(): HTMLElement {
  return screen.getByText((_, element) => {
    return element?.tagName === 'P' && element.textContent === LEGAL_SENTENCE;
  });
}

describe('SignupPage under the beta stage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseStage.current = 'beta';
    setSearch({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens on the beta welcome instead of the form', () => {
    renderRoute(Route);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Welcome to the HushBox beta' })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create account' })).not.toBeInTheDocument();
  });

  it('shows every line of the approved welcome copy in its approved order', () => {
    const { container } = renderRoute(Route);

    const text = container.textContent;
    const positions = APPROVED_STEP_COPY.map((line) => text.indexOf(line));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].toSorted((a, b) => a - b));
  });

  it('links Read the full beta terms to the beta section of the Terms', () => {
    renderRoute(Route);

    expect(screen.getByRole('link', { name: 'Read the full beta terms' })).toHaveAttribute(
      'href',
      '/terms#beta'
    );
  });

  it('offers the log in link on the welcome, below the beta terms link', () => {
    const { container } = renderRoute(Route);

    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    const text = container.textContent;
    expect(text.indexOf('Already have an account? Log in')).toBeGreaterThan(
      text.indexOf('Read the full beta terms')
    );
  });

  it('reveals the form when Join the beta is selected', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.click(screen.getByRole('button', { name: 'Join the beta' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Create your account' })).toBeVisible();
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.queryByText('Welcome to the HushBox beta')).not.toBeInTheDocument();
  });

  it('moves focus to the username field when the form is revealed', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.click(screen.getByRole('button', { name: 'Join the beta' }));

    expect(screen.getByLabelText(/username/i)).toHaveFocus();
  });

  it('keeps the legal sentence unchanged on the revealed form', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.click(screen.getByRole('button', { name: 'Join the beta' }));

    expect(legalSentence()).toBeInTheDocument();
  });

  it('sends the campaign tag the link carried after Join the beta', async () => {
    setSearch({ c: 'spring-launch' });
    vi.mocked(signUp.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.click(screen.getByRole('button', { name: 'Join the beta' }));
    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).toHaveBeenCalledWith(
      expect.objectContaining({ campaign: 'spring-launch' })
    );
  });
});

describe('SignupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseStage.current = 'stable';
    setSearch({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens on the form with no beta welcome under the stable stage', () => {
    renderRoute(Route);

    expect(screen.getByRole('heading', { level: 1, name: 'Create your account' })).toBeVisible();
    expect(screen.queryByText('Welcome to the HushBox beta')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join the beta' })).not.toBeInTheDocument();
  });

  it('keeps the legal sentence unchanged under the stable stage', () => {
    renderRoute(Route);

    expect(legalSentence()).toBeInTheDocument();
  });

  it('renders signup form with all fields', () => {
    renderRoute(Route);

    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  }, 15_000);

  it('renders login link', () => {
    renderRoute(Route);

    expect(screen.getByRole('link', { name: /log in/i })).toHaveAttribute('href', '/login');
  });

  it('marks the brand tagline as a reading surface so it renders in the serif', () => {
    renderRoute(Route);

    expect(screen.getByText(PRODUCT_TAGLINE)).toHaveAttribute('data-reading');
  });

  it('shows the product tagline under the title', () => {
    renderRoute(Route);

    expect(screen.getByText(PRODUCT_TAGLINE)).toBeInTheDocument();
  });

  it('sets the page title in the auth title role, in ink', () => {
    renderRoute(Route);

    expect(screen.getByRole('heading', { level: 1, name: 'Create your account' })).toHaveClass(
      'text-auth-title',
      'text-foreground'
    );
  });

  it('renders Create account as the extra-large full-width button with no cut', () => {
    renderRoute(Route);

    const button = screen.getByRole('button', { name: 'Create account' });
    expect(button).toHaveAttribute('data-size', 'xl');
    expect(button).toHaveAttribute('data-block');
    expect(button.style.getPropertyValue('clip-path')).toBe('');
  });

  it('draws the username and email fields with the control border', () => {
    renderRoute(Route);

    expect(screen.getByLabelText(/username/i)).toHaveClass('border-border-control');
    expect(screen.getByLabelText(/^email$/i)).toHaveClass('border-border-control');
  });

  it('keeps the username and email fields valid before they are touched', () => {
    renderRoute(Route);

    expect(screen.getByLabelText(/username/i)).not.toHaveAttribute('aria-describedby');
    expect(screen.getByLabelText(/^email$/i)).not.toHaveAttribute('aria-describedby');
  });

  it('validates email format', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'invalid-email');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).not.toHaveBeenCalled();
  });

  it('validates password minimum length', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'short');
    await user.type(screen.getByLabelText(/confirm password/i), 'short');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).not.toHaveBeenCalled();
  });

  it('validates passwords match', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'different123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).not.toHaveBeenCalled();
    expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument();
  });

  it('calls signUp.email with valid data', async () => {
    vi.mocked(signUp.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).toHaveBeenCalledWith({
      username: 'test_user',
      email: 'test@example.com',
      password: 'password123',
    });
  });

  it('shows success message on successful signup', async () => {
    vi.mocked(signUp.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(screen.getByText(/check your email/i)).toBeInTheDocument();
  });

  it('shows inline error on signup failure', async () => {
    vi.mocked(signUp.email).mockResolvedValue({
      error: { message: 'Email already exists' },
    });
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    const errorAlert = screen
      .getAllByRole('alert')
      .find((el) => el.textContent === 'Email already exists');
    expect(errorAlert).toBeInTheDocument();
  });

  it('shows fallback error message when error has no message', async () => {
    vi.mocked(signUp.email).mockResolvedValue({
      error: { message: 'Signup failed' },
    });
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    const errorAlert = screen
      .getAllByRole('alert')
      .find((el) => el.textContent === 'Signup failed');
    expect(errorAlert).toBeInTheDocument();
  });

  it('shows success message when username is valid as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');

    expect(screen.getByText('Looks good!')).toBeInTheDocument();
  });

  it('shows success message when email is valid as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');

    expect(screen.getByText('Valid email')).toBeInTheDocument();
  });

  it('shows error message when email is invalid as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email/i), 'invalid');

    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a valid email');
  });

  it('shows success message when password meets requirements as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/^password$/i), 'password123');

    expect(screen.getByText('Password meets requirements')).toBeInTheDocument();
  });

  it('shows error message when password is too short as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/^password$/i), 'short');

    expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 8 characters');
  });

  it('shows success message when confirm password matches as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');

    expect(screen.getByText('Passwords match')).toBeInTheDocument();
  });

  it('shows error message when confirm password does not match as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'different');

    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('Passwords do not match');
  });

  it('Enter on username focuses email field', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.click(screen.getByLabelText(/username/i));
    await user.keyboard('{Enter}');

    expect(screen.getByLabelText(/email/i)).toHaveFocus();
  });

  it('Enter on email focuses password field', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.click(screen.getByLabelText(/email/i));
    await user.keyboard('{Enter}');

    expect(screen.getByLabelText(/^password$/i)).toHaveFocus();
  });

  it('renders terms acceptance text with links', () => {
    renderRoute(Route);

    expect(screen.getByText(/by creating an account, you agree to our/i)).toBeInTheDocument();

    const termsLink = screen.getByRole('link', { name: /terms of service/i });
    expect(termsLink).toHaveAttribute('href', '/terms');
    expect(termsLink).toHaveAttribute('target', '_blank');

    const privacyLink = screen.getByRole('link', { name: /privacy policy/i });
    expect(privacyLink).toHaveAttribute('href', '/privacy');
    expect(privacyLink).toHaveAttribute('target', '_blank');
  });

  it('renders new-password field with new-password autocomplete hint', () => {
    renderRoute(Route);

    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute('autocomplete', 'new-password');
  });
});

describe('SignupPage campaign tag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseStage.current = 'stable';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the campaign tag the link carried', async () => {
    setSearch({ c: 'spring-launch' });
    vi.mocked(signUp.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).toHaveBeenCalledWith(
      expect.objectContaining({ campaign: 'spring-launch' })
    );
  });

  it('sends no campaign when the link carried no tag', async () => {
    setSearch({});
    vi.mocked(signUp.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).toHaveBeenCalledWith(expect.objectContaining({ campaign: undefined }));
  });
});

describe('/_auth/signup validateSearch', () => {
  const validateSearch = Route.options.validateSearch as (search: Record<string, unknown>) => {
    c?: string;
  };

  it('keeps a well-formed campaign tag', () => {
    expect(validateSearch({ c: 'spring-launch' })).toEqual({ c: 'spring-launch' });
  });

  it('drops a tag whose characters the pattern refuses', () => {
    expect(validateSearch({ c: 'Spring Launch!' })).toEqual({});
  });

  it('drops a tag longer than the pattern allows', () => {
    expect(validateSearch({ c: 'a'.repeat(41) })).toEqual({});
  });

  it('drops a non-string value', () => {
    expect(validateSearch({ c: 42 })).toEqual({});
    expect(validateSearch({ c: null })).toEqual({});
    expect(validateSearch({ c: { nested: 'x' } })).toEqual({});
  });

  it('returns nothing when the key is absent', () => {
    expect(validateSearch({})).toEqual({});
  });

  it('reads no key but the campaign tag', () => {
    expect(validateSearch({ c: 'spring-launch', ref: 'elsewhere', utm_source: 'mail' })).toEqual({
      c: 'spring-launch',
    });
  });
});
