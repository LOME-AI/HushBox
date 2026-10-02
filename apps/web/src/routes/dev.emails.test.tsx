import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { EMAIL_LIGHT_SCHEME_CONDITION } from '@hushbox/shared/design-tokens';
import { renderRoute, renderWithProviders } from '@/test-utils/render';
import { Route, type EmailsSearch } from './dev.emails';
import { devEmailsKeys } from './-dev-emails-keys';

describe('devEmailsKeys', () => {
  it('roots the dev-emails query under the factory', () => {
    expect(devEmailsKeys.all).toEqual(['dev-emails']);
  });
});

const mockEnv = vi.hoisted(() => ({
  isDev: true,
  isLocalDev: true,
  isProduction: false,
  isCI: false,
  isE2E: false,
  requiresRealServices: false,
}));
vi.mock('@/lib/platform/env', () => ({ env: mockEnv }));

// Keep the real router (createFileRoute must run); stub only Link, which needs router
// context renderRoute does not provide. The stub writes the search into the href so a
// test can read where each link goes.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Link: ({
      children,
      to,
      search,
      ...props
    }: {
      children: React.ReactNode;
      to: string;
      search?: Record<string, string>;
    }): React.JSX.Element => (
      <a href={`${to}?${new URLSearchParams(search).toString()}`} {...props}>
        {children}
      </a>
    ),
  };
});

function setSearch(search: EmailsSearch): void {
  vi.spyOn(Route, 'useSearch').mockReturnValue(search);
}

type ValidateSearch = (search: Record<string, unknown>) => EmailsSearch;

function parseSearch(search: Record<string, unknown>): EmailsSearch {
  const validate = Route.options.validateSearch as ValidateSearch | undefined;
  if (validate === undefined) throw new Error('the route declares no search validator');
  return validate(search);
}

/** The renderer's light variant, written as the renderer's head style writes it. */
const LIGHT_RULES = `${EMAIL_LIGHT_SCHEME_CONDITION} {\n  .x { color: #1a1a1a; }\n}`;

// The page's queryFn calls `fetchJson(client.dev.emails.$get())`; both are
// mocked at the typed-client seam so the success-path rendering stays covered
// without a real network round trip.
const { mockEmailsGet, mockFetchJson } = vi.hoisted(() => ({
  mockEmailsGet: vi.fn(),
  mockFetchJson: vi.fn(),
}));
vi.mock('@/lib/api-client.js', () => ({
  client: { dev: { emails: { $get: mockEmailsGet } } },
  fetchJson: (...args: unknown[]): unknown => mockFetchJson(...args),
}));

interface EmailTemplate {
  name: string;
  label: string;
  html: string;
}

const mockTemplates: EmailTemplate[] = [
  {
    name: 'verification',
    label: 'Email Verification',
    html: `<html><head><style>${LIGHT_RULES}</style></head><body><h1>Verify your email</h1></body></html>`,
  },
  {
    name: 'password-changed',
    label: 'Password Changed',
    html: '<html><body><h1>Password changed</h1></body></html>',
  },
  {
    name: 'welcome',
    label: 'Welcome',
    html: '<html><body><h1>Welcome to HushBox</h1></body></html>',
  },
];

describe('EmailsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.isDev = true;
    setSearch({});
  });

  describe('dev-only route guard', () => {
    it('allows the route in dev without redirecting', () => {
      mockEnv.isDev = true;
      const beforeLoad = Route.options.beforeLoad as (() => void) | undefined;
      expect(beforeLoad).toBeDefined();

      expect(() => {
        beforeLoad!();
      }).not.toThrow();
    });

    it('redirects to login outside dev', () => {
      mockEnv.isDev = false;
      const beforeLoad = Route.options.beforeLoad as (() => void) | undefined;
      expect(beforeLoad).toBeDefined();

      expect(() => {
        beforeLoad!();
      }).toThrow();
    });
  });

  describe('loading state', () => {
    it('shows loading indicator when fetching templates', () => {
      mockFetchJson.mockReturnValue(new Promise(() => {})); // never resolves

      renderRoute(Route);

      expect(screen.getByText(/loading email templates/i)).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows error message when fetch fails', async () => {
      mockFetchJson.mockRejectedValue(new Error('Network error'));

      renderRoute(Route);

      await waitFor(() => {
        expect(screen.getByText(/failed to load email templates/i)).toBeInTheDocument();
      });
    });
  });

  describe('templates display', () => {
    it('fetches templates through the typed dev/emails client route', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        expect(screen.getByText(mockTemplates[0]!.label)).toBeInTheDocument();
      });
      expect(mockEmailsGet).toHaveBeenCalledTimes(1);
    });

    it('sizes the page to its container, not the viewport', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      // The title also renders in the loading branch, so wait on a
      // loaded-only marker before asserting against the loaded layout.
      await waitFor(() => {
        expect(screen.getByText(mockTemplates[0]!.label)).toBeInTheDocument();
      });
      // min-h-full, not min-h-dvh: the root route's h-dvh banner-row layout
      // owns the viewport height; the page fills the flex-1 content region
      // below the app-wide banner.
      const page = screen.getByText('Email Templates').parentElement?.parentElement;
      expect(page).toHaveClass('min-h-full');
    });

    it('renders a heading for each template', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        for (const template of mockTemplates) {
          expect(screen.getByText(template.label)).toBeInTheDocument();
        }
      });
    });

    it('renders a dark and a light frame for each template', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        for (const template of mockTemplates) {
          for (const scheme of ['dark', 'light'] as const) {
            expect(
              screen.getByTestId(TEST_ID_BUILDERS.emailSchemeIframe(template.name, scheme))
            ).toBeInTheDocument();
          }
        }
      });
      expect(screen.getAllByTitle(/email template preview/i)).toHaveLength(
        mockTemplates.length * 2
      );
    });

    it.each(['dark', 'light'] as const)('labels each %s frame with its scheme', async (scheme) => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        const iframe = screen.getByTestId(
          TEST_ID_BUILDERS.emailSchemeIframe(mockTemplates[0]!.name, scheme)
        );
        const figure = iframe.closest('figure');
        expect(figure).not.toBeNull();
        expect(within(figure!).getByText(scheme)).toBeInTheDocument();
      });
    });

    it('pins the light variant on in the light frame', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        const iframe = screen.getByTestId(
          TEST_ID_BUILDERS.emailSchemeIframe(mockTemplates[0]!.name, 'light')
        );
        expect(iframe).toHaveAttribute(
          'srcDoc',
          mockTemplates[0]!.html.replace(EMAIL_LIGHT_SCHEME_CONDITION, '@media all')
        );
      });
    });

    it('pins the light variant off in the dark frame', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        const iframe = screen.getByTestId(
          TEST_ID_BUILDERS.emailSchemeIframe(mockTemplates[0]!.name, 'dark')
        );
        expect(iframe).toHaveAttribute(
          'srcDoc',
          mockTemplates[0]!.html.replace(EMAIL_LIGHT_SCHEME_CONDITION, '@media not all')
        );
      });
    });

    it('passes an email with no light variant through unchanged', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        for (const scheme of ['dark', 'light'] as const) {
          const iframe = screen.getByTestId(
            TEST_ID_BUILDERS.emailSchemeIframe(mockTemplates[1]!.name, scheme)
          );
          expect(iframe).toHaveAttribute('srcDoc', mockTemplates[1]!.html);
        }
      });
    });

    it.each(['dark', 'light'] as const)('declares the %s scheme on its frame', async (scheme) => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        const iframe = screen.getByTestId(
          TEST_ID_BUILDERS.emailSchemeIframe(mockTemplates[0]!.name, scheme)
        );
        expect(iframe).toHaveClass(`scheme-${scheme}`);
      });
    });

    it.each(['dark', 'light'] as const)(
      'links each %s frame to its full-width view',
      async (scheme) => {
        mockFetchJson.mockResolvedValue({ templates: mockTemplates });

        renderRoute(Route);

        const name = mockTemplates[0]!.name;
        const label = mockTemplates[0]!.label;
        await waitFor(() => {
          const link = screen.getByRole('link', {
            name: `Open at full width: ${label}, ${scheme}`,
          });
          expect(link).toHaveAttribute(
            'href',
            `/dev/emails?${new URLSearchParams({ view: name, scheme }).toString()}`
          );
        });
      }
    );

    it('sandboxes iframes to prevent script execution', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        const iframes = screen.getAllByTitle(/email template preview/i);
        expect(iframes).toHaveLength(mockTemplates.length * 2);
        for (const iframe of iframes) {
          expect(iframe).toHaveAttribute('sandbox', '');
        }
      });
    });
  });

  describe('full view', () => {
    it.each(['dark', 'light'] as const)(
      'shows only the named email in the %s scheme',
      async (scheme) => {
        setSearch({ view: 'verification', scheme });
        mockFetchJson.mockResolvedValue({ templates: mockTemplates });

        renderRoute(Route);

        await waitFor(() => {
          expect(
            screen.getByTestId(TEST_ID_BUILDERS.emailSchemeIframe('verification', scheme))
          ).toBeInTheDocument();
        });
        expect(screen.getAllByTitle(/email/i)).toHaveLength(1);
      }
    );

    it('pins the scheme in the full view', async () => {
      setSearch({ view: 'verification', scheme: 'light' });
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        expect(
          screen.getByTestId(TEST_ID_BUILDERS.emailSchemeIframe('verification', 'light'))
        ).toHaveAttribute(
          'srcDoc',
          mockTemplates[0]!.html.replace(EMAIL_LIGHT_SCHEME_CONDITION, '@media all')
        );
      });
    });

    it('draws no page chrome around the full view', async () => {
      setSearch({ view: 'verification', scheme: 'dark' });
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        expect(
          screen.getByTestId(TEST_ID_BUILDERS.emailSchemeIframe('verification', 'dark'))
        ).toBeInTheDocument();
      });
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('fills the page with the full-view frame', async () => {
      setSearch({ view: 'verification', scheme: 'dark' });
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        expect(
          screen.getByTestId(TEST_ID_BUILDERS.emailSchemeIframe('verification', 'dark'))
        ).toHaveClass('h-full', 'w-full');
      });
    });

    it('falls back to the list for an unknown email', async () => {
      setSearch({ view: 'no-such-email', scheme: 'dark' });
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        expect(screen.getAllByTitle(/email template preview/i)).toHaveLength(
          mockTemplates.length * 2
        );
      });
      expect(screen.getByRole('heading', { name: /email templates/i })).toBeInTheDocument();
    });

    it('falls back to the list when no scheme is given', async () => {
      setSearch({ view: 'verification' });
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        expect(screen.getAllByTitle(/email template preview/i)).toHaveLength(
          mockTemplates.length * 2
        );
      });
    });
  });

  describe('search validation', () => {
    it('keeps a view name and a known scheme', () => {
      expect(parseSearch({ view: 'welcome', scheme: 'light' })).toEqual({
        view: 'welcome',
        scheme: 'light',
      });
    });

    it('drops an unknown scheme', () => {
      expect(parseSearch({ view: 'welcome', scheme: 'sepia' })).toEqual({ view: 'welcome' });
    });

    it('drops a view that is not a string', () => {
      expect(parseSearch({ view: 7, scheme: 'dark' })).toEqual({ scheme: 'dark' });
    });
  });

  // The router builds a route's search as its parent's raw search overlaid with the keys
  // the route's validator kept, so a dropped key reaches the page raw unless it re-parses.
  describe('through the router', () => {
    function renderAt(location: string): void {
      vi.restoreAllMocks();
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });
      const component = Route.options.component;
      if (component === undefined) throw new Error('the route has no component');
      const rootRoute = createRootRoute();
      // The route file's own validator and component, mounted at the path its id names.
      const galleryRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/dev/emails',
        validateSearch: parseSearch,
        component,
      });
      const router = createRouter({
        routeTree: rootRoute.addChildren([galleryRoute]),
        history: createMemoryHistory({ initialEntries: [location] }),
      });
      renderWithProviders(<RouterProvider router={router} />);
    }

    it('opens a known email in a known scheme alone', async () => {
      renderAt('/dev/emails?view=verification&scheme=light');

      await waitFor(() => {
        expect(
          screen.getByTestId(TEST_ID_BUILDERS.emailSchemeIframe('verification', 'light'))
        ).toBeInTheDocument();
      });
      expect(screen.getAllByTitle(/email template preview/i)).toHaveLength(1);
    });

    it('renders the list for a known email with an unknown scheme', async () => {
      renderAt('/dev/emails?view=verification&scheme=sepia');

      await waitFor(() => {
        expect(screen.getAllByTitle(/email template preview/i)).toHaveLength(
          mockTemplates.length * 2
        );
      });
    });

    it('renders the list for an unknown email', async () => {
      renderAt('/dev/emails?view=no-such-email&scheme=dark');

      await waitFor(() => {
        expect(screen.getAllByTitle(/email template preview/i)).toHaveLength(
          mockTemplates.length * 2
        );
      });
    });
  });

  describe('empty state', () => {
    it('shows empty message when no templates returned', async () => {
      mockFetchJson.mockResolvedValue({ templates: [] });

      renderRoute(Route);

      await waitFor(() => {
        expect(screen.getByText(/no email templates found/i)).toBeInTheDocument();
      });
    });

    it('falls back to an empty list when the response omits templates', async () => {
      // data is defined but has no `templates` key, exercising the `?? []` guard.
      mockFetchJson.mockResolvedValue({});

      renderRoute(Route);

      await waitFor(() => {
        expect(screen.getByText(/no email templates found/i)).toBeInTheDocument();
      });
    });
  });

  it('renders page title', async () => {
    mockFetchJson.mockResolvedValue({ templates: mockTemplates });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /email templates/i })).toBeInTheDocument();
    });
  });

  it('shows template count in subtitle', async () => {
    mockFetchJson.mockResolvedValue({ templates: mockTemplates });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByText(/3 templates/i)).toBeInTheDocument();
    });
  });
});
