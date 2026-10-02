import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import {
  APP_RETURN_TO_BILLING_URL,
  MANAGE_BALANCE_ONLINE_LABEL,
} from '@hushbox/shared/billing-portal';
import { authClient } from '@/lib/auth/auth';
import { renderRoute } from '@/test-utils/render';
import { Route, type BillingPortalSearch } from './billing-portal';

// Keep the real router (createFileRoute must run); stub only Link, which needs
// router context renderRoute does not provide.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Link: ({
      children,
      to,
      ...props
    }: {
      children: React.ReactNode;
      to: string;
    }): React.JSX.Element => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

vi.mock('@/lib/auth/auth', () => ({
  authClient: {
    tokenLogin: vi.fn(),
  },
}));

const { openPayment, billingContentProps } = vi.hoisted(() => ({
  openPayment: vi.fn<() => void>(),
  billingContentProps: {
    surface: undefined as string | undefined,
  },
}));

// BillingContent runs live balance/transaction queries; the ready-state contract is that
// it is mounted on the portal surface and draws the portal's actions once a purchase
// completes, so the stub records the surface and draws the actions at once.
vi.mock('@/components/billing/billing-content', () => ({
  BillingContent: ({
    surface,
    purchasedActions,
  }: {
    surface: string;
    purchasedActions?: (actions: { openPayment: () => void }) => React.ReactNode;
  }): React.JSX.Element => {
    billingContentProps.surface = surface;
    return <div data-testid="billing-content">{purchasedActions?.({ openPayment })}</div>;
  },
}));

vi.mock('@/components/shared/theme-toggle', () => ({
  ThemeToggle: (): React.JSX.Element => <div data-testid="theme-toggle" />,
}));

const ROUTE_SOURCES = import.meta.glob<string>('./billing-portal.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const EXPIRED_SENTENCE =
  'This link has expired or was already used. For a new one, open the HushBox app and tap Manage Balance Online.';

function setSearch(search: BillingPortalSearch): void {
  vi.spyOn(Route, 'useSearch').mockReturnValue(search);
}

/**
 * The route announcer looks up `#main`, so each branch must render exactly one,
 * and it must be the page's focusable main landmark.
 */
function expectOneMainFocusTarget(): HTMLElement {
  const targets = document.querySelectorAll<HTMLElement>('#main');
  expect(targets).toHaveLength(1);
  const [target] = targets;
  expect(target).toBe(screen.getByRole('main'));
  expect(target).toHaveAttribute('tabindex', '-1');
  return target!;
}

describe('/billing-portal validateSearch', () => {
  const validateSearch = Route.options.validateSearch as (
    search: Record<string, unknown>
  ) => BillingPortalSearch;

  it('extracts a string token', () => {
    expect(validateSearch({ token: 'tok-123' })).toEqual({ token: 'tok-123' });
  });

  it('returns undefined token when missing', () => {
    expect(validateSearch({})).toEqual({ token: undefined });
  });

  it('returns undefined token when not a string', () => {
    expect(validateSearch({ token: 42 })).toEqual({ token: undefined });
    expect(validateSearch({ token: null })).toEqual({ token: undefined });
  });

  it('drops an object-valued token via zod validation', () => {
    expect(validateSearch({ token: { nested: 'x' } })).toEqual({ token: undefined });
  });
});

describe('/billing-portal route component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the foundation's spinner while exchanging the token", () => {
    setSearch({ token: 'tok-123' });
    // Never-resolving promise keeps the component in its loading state.
    vi.mocked(authClient.tokenLogin).mockReturnValue(new Promise(() => {}));

    const { container } = renderRoute(Route);

    expect(container.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.billingPortal)).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.billingPortalError)).not.toBeInTheDocument();
  });

  it('renders the portal chrome and billing content after a successful exchange', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({});

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortal)).toBeInTheDocument();
    });
    expect(authClient.tokenLogin).toHaveBeenCalledWith({ token: 'tok-123' });
    expect(screen.getByTestId('billing-content')).toBeInTheDocument();
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /hushbox/i })).toHaveAttribute('href', '/chat');
  });

  it('titles the expired state "Link expired" as the page heading', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Link expired' })).toBeInTheDocument();
  });

  it('tells the user how to get a new link, word for word', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    // The button's name is a bold element inside the sentence, so the match reads the whole
    // paragraph's text rather than its own text nodes alone.
    expect(
      screen.getByText((_content, element) => element?.textContent === EXPIRED_SENTENCE, {
        selector: 'p',
      })
    ).toBeInTheDocument();
  });

  it("names the app's button in bold through its shared label", async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    expect(screen.getByText(MANAGE_BALANCE_ONLINE_LABEL).tagName).toBe('B');
  });

  it("keeps the server's own failure text off the page", async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    expect(screen.queryByText(/token expired/i)).not.toBeInTheDocument();
  });

  it('offers Log in as a link to the login page', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', ROUTES.LOGIN);
  });

  it('draws Log in as a block button', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('data-block');
  });

  it('draws the expired state under the portal header', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /hushbox/i })).toHaveAttribute('href', ROUTES.CHAT);
  });

  it('keeps the portal marker off the expired state', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    expect(screen.queryByTestId(TEST_IDS.billingPortal)).not.toBeInTheDocument();
  });

  it('keeps the portal header off the loading state', () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockReturnValue(new Promise(() => {}));

    renderRoute(Route);

    expect(screen.queryByTestId('theme-toggle')).not.toBeInTheDocument();
  });

  it('mounts the billing content on the portal surface', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({});

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortal)).toBeInTheDocument();
    });
    expect(billingContentProps.surface).toBe('portal');
  });

  it('offers Return to the app after a purchase, linking to the app with no token', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({});

    renderRoute(Route);

    const link = await screen.findByTestId(TEST_IDS.returnToAppLink);
    expect(link).toHaveAccessibleName('Return to the app');
    expect(link).toHaveAttribute('href', APP_RETURN_TO_BILLING_URL);
    expect(link.getAttribute('href')).not.toContain('token');
  });

  it('marks Return to the app with an up-right arrow', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({});

    renderRoute(Route);

    const link = await screen.findByTestId(TEST_IDS.returnToAppLink);
    expect(link.querySelector('svg.lucide-arrow-up-right')).toHaveAttribute('aria-hidden', 'true');
  });

  it('opens the payment dialog from Add Credits after a purchase', async () => {
    const user = userEvent.setup();
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({});

    renderRoute(Route);

    await user.click(await screen.findByRole('button', { name: 'Add Credits' }));

    expect(openPayment).toHaveBeenCalledTimes(1);
  });

  it('puts Add Credits before Return to the app while the pair sits side by side', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({});

    renderRoute(Route);

    const returnLink = await screen.findByTestId(TEST_IDS.returnToAppLink);
    const addCredits = screen.getByRole('button', { name: 'Add Credits' });
    expect(addCredits.compareDocumentPosition(returnLink)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('writes no spin animation of its own', () => {
    const sources = Object.values(ROUTE_SOURCES);

    expect(sources).toHaveLength(1);
    expect(sources[0]).not.toContain('animate-spin');
  });

  it('renders the loading state inside a main landmark', () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockReturnValue(new Promise(() => {}));

    const { container } = renderRoute(Route);

    expect(screen.getByRole('main')).toContainElement(
      container.querySelector('[data-slot="spinner"]')
    );
  });

  it('renders the expired-link error inside a main landmark', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    expect(screen.getByRole('main')).toContainElement(
      screen.getByTestId(TEST_IDS.billingPortalError)
    );
  });

  it('renders the billing content inside a main landmark', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({});

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortal)).toBeInTheDocument();
    });
    expect(screen.getByRole('main')).toContainElement(screen.getByTestId('billing-content'));
  });

  it('gives the loading state one focusable main#main', () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockReturnValue(new Promise(() => {}));

    renderRoute(Route);

    expectOneMainFocusTarget();
  });

  it('gives the expired-link error one focusable main#main', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    expectOneMainFocusTarget();
  });

  it('gives the billing content one focusable main#main', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({});

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortal)).toBeInTheDocument();
    });
    expectOneMainFocusTarget();
  });

  it('keeps focus on the main#main that held it while loading when the token exchange succeeds', async () => {
    setSearch({ token: 'tok-123' });
    const exchange = Promise.withResolvers<{ error?: { message: string } }>();
    vi.mocked(authClient.tokenLogin).mockReturnValue(exchange.promise);
    renderRoute(Route);
    // The loading state has no heading, so the route announcer focuses `#main` itself.
    const loadingMain = expectOneMainFocusTarget();
    loadingMain.focus();

    exchange.resolve({});

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortal)).toBeInTheDocument();
    });
    expect(expectOneMainFocusTarget()).toBe(loadingMain);
    expect(document.activeElement).toBe(loadingMain);
  });

  it('keeps the portal header outside the main landmark', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({});

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortal)).toBeInTheDocument();
    });
    expect(screen.getByRole('main')).not.toContainElement(screen.getByTestId('theme-toggle'));
  });

  // The three sizing tests below pin h-full, not h-dvh: the root route's h-dvh
  // banner-row layout owns the viewport height, and a viewport unit here would
  // overflow the content region by the banner's height when a banner is active.
  it('sizes the loading state to its container, not the viewport', () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockReturnValue(new Promise(() => {}));

    const { container } = renderRoute(Route);

    expect(container.querySelector('[data-slot="spinner"]')?.parentElement).toHaveClass('h-full');
  });

  it('sizes the error state to its container, not the viewport', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    expect(screen.getByTestId(TEST_IDS.billingPortalError).parentElement).toHaveClass('h-full');
  });

  it('insets the expired-link message 16px from each side of the focusable main', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    // The main draws its focus ring on its own edge, so the inset keeps the text off the ring
    // as well as off the screen edge on a phone.
    expect(screen.getByTestId(TEST_IDS.billingPortalError).parentElement).toHaveClass('px-4');
  });

  it('sizes the portal chrome to its container, not the viewport', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({});

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortal)).toBeInTheDocument();
    });
    expect(screen.getByTestId(TEST_IDS.billingPortal)).toHaveClass('h-full');
  });

  it('redirects to /login when no token is present', () => {
    setSearch({ token: undefined });
    const hrefSetter = vi.fn();
    vi.spyOn(globalThis, 'location', 'get').mockReturnValue({
      set href(value: string) {
        hrefSetter(value);
      },
    } as unknown as Location);

    renderRoute(Route);

    expect(hrefSetter).toHaveBeenCalledWith('/login');
    expect(authClient.tokenLogin).not.toHaveBeenCalled();
  });
});
