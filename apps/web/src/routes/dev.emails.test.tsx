import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => vi.fn()),
  redirect: vi.fn((options: { to: string }) => {
    throw new Error(`Redirect to ${options.to}`);
  }),
}));

const mockFetchJson = vi.fn();
vi.mock('@/lib/api-client', () => ({
  client: {
    api: {
      dev: {
        emails: {
          $get: vi.fn(),
        },
      },
    },
  },
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
    html: '<html><body><h1>Verify your email</h1></body></html>',
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

function createWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('EmailsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loading state', () => {
    it('shows loading indicator when fetching templates', async () => {
      mockFetchJson.mockReturnValue(new Promise(() => {})); // never resolves

      const { EmailsPage } = await import('./dev.emails');
      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <EmailsPage />
        </Wrapper>
      );

      expect(screen.getByText(/loading email templates/i)).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows error message when fetch fails', async () => {
      mockFetchJson.mockRejectedValue(new Error('Network error'));

      const { EmailsPage } = await import('./dev.emails');
      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <EmailsPage />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByText(/failed to load email templates/i)).toBeInTheDocument();
      });
    });
  });

  describe('templates display', () => {
    it('renders a heading for each template', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      const { EmailsPage } = await import('./dev.emails');
      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <EmailsPage />
        </Wrapper>
      );

      await waitFor(() => {
        for (const template of mockTemplates) {
          expect(screen.getByText(template.label)).toBeInTheDocument();
        }
      });
    });

    it('renders an iframe for each template', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      const { EmailsPage } = await import('./dev.emails');
      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <EmailsPage />
        </Wrapper>
      );

      await waitFor(() => {
        const iframes = screen.getAllByTitle(/email template preview/i);
        expect(iframes).toHaveLength(mockTemplates.length);
      });
    });

    it('sets iframe srcDoc to template html', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      const { EmailsPage } = await import('./dev.emails');
      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <EmailsPage />
        </Wrapper>
      );

      await waitFor(() => {
        for (const template of mockTemplates) {
          const iframe = screen.getByTestId(`email-iframe-${template.name}`);
          expect(iframe).toHaveAttribute('srcDoc', template.html);
        }
      });
    });

    it('sandboxes iframes to prevent script execution', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      const { EmailsPage } = await import('./dev.emails');
      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <EmailsPage />
        </Wrapper>
      );

      await waitFor(() => {
        const iframes = screen.getAllByTitle(/email template preview/i);
        for (const iframe of iframes) {
          expect(iframe).toHaveAttribute('sandbox', '');
        }
      });
    });
  });

  describe('empty state', () => {
    it('shows empty message when no templates returned', async () => {
      mockFetchJson.mockResolvedValue({ templates: [] });

      const { EmailsPage } = await import('./dev.emails');
      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <EmailsPage />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByText(/no email templates found/i)).toBeInTheDocument();
      });
    });
  });

  it('renders page title', async () => {
    mockFetchJson.mockResolvedValue({ templates: mockTemplates });

    const { EmailsPage } = await import('./dev.emails');
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <EmailsPage />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /email templates/i })).toBeInTheDocument();
    });
  });

  it('shows template count in subtitle', async () => {
    mockFetchJson.mockResolvedValue({ templates: mockTemplates });

    const { EmailsPage } = await import('./dev.emails');
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <EmailsPage />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText(/3 templates/i)).toBeInTheDocument();
    });
  });
});
