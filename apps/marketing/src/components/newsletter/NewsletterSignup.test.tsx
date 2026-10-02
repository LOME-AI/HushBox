import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import hydrateAstroIsland from '@astrojs/react/client.js';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { ROUTES } from '@hushbox/shared/routes';
import { NEWSLETTER_SENT_ATTRIBUTE, NewsletterSignup } from './NewsletterSignup';

const SENT_HEADING = 'Check your inbox';
const SENT_TEXT = 'Click the link in the email to confirm.';
const INVALID_TEXT = 'Please enter a valid email address.';
const CHILD_TEXT = 'Slot content from the page';
const VARIANTS = [
  ['full', false],
  ['compact', true],
] as const;

async function findSentHeading(): Promise<HTMLElement> {
  return screen.findByRole('heading', { level: 2, name: SENT_HEADING });
}

function mockFetch(response: { ok: boolean; status: number } | 'reject'): ReturnType<typeof vi.fn> {
  const function_ =
    response === 'reject'
      ? vi.fn(() => Promise.reject(new Error('network down')))
      : vi.fn(() =>
          Promise.resolve({
            ok: response.ok,
            status: response.status,
            json: () => Promise.resolve(response.ok ? { ok: true } : { code: 'RATE_LIMITED' }),
          })
        );
  vi.stubGlobal('fetch', function_);
  return function_;
}

const SLOT_HTML = '<p>Read the <a href="/privacy">Privacy Policy</a>.</p>';
const HYDRATION_MISMATCH = "didn't match the client properties";
const ISLAND_PREFIX = 'r0';

/**
 * The server half of an Astro island whose default slot is `SLOT_HTML`: Astro's React renderer
 * wraps slot content in an `astro-slot` element carrying it as inner HTML. The island element
 * carries `ssr` so its client hydrates rather than renders, and the `prefix` both halves pass to `useId`.
 */
function mountServerRenderedIsland(): HTMLElement {
  const slot = createElement('astro-slot', {
    suppressHydrationWarning: true,
    dangerouslySetInnerHTML: { __html: SLOT_HTML },
  });
  const island = document.createElement('astro-island');
  island.setAttribute('ssr', '');
  island.setAttribute('prefix', ISLAND_PREFIX);
  island.innerHTML = renderToString(createElement(NewsletterSignup, { compact: true }, slot), {
    identifierPrefix: ISLAND_PREFIX,
  });
  document.body.append(island);
  return island;
}

/** Tags every same-origin link under `root` with `?c=`, as the growth script does at load. */
function tagSameOriginLinks(root: HTMLElement, tag: string): void {
  for (const anchor of root.querySelectorAll('a[href]')) {
    const url = new URL(anchor.getAttribute('href') ?? '', location.href);
    if (url.origin !== location.origin) continue;
    url.searchParams.set('c', tag);
    anchor.setAttribute('href', url.pathname + url.search + url.hash);
  }
}

async function submitValidEmail(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByTestId(TEST_IDS.newsletterSignupInput), 'reader@example.com');
  await user.click(screen.getByTestId(TEST_IDS.newsletterSignupSubmit));
}

describe('NewsletterSignup', () => {
  beforeEach(() => {
    mockFetch({ ok: true, status: 200 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the email input with its test id', () => {
    render(<NewsletterSignup />);
    expect(screen.getByTestId(TEST_IDS.newsletterSignupInput)).toBeInTheDocument();
  });

  it('labels the email field "Email address"', () => {
    render(<NewsletterSignup />);
    expect(screen.getByLabelText('Email address')).toBe(
      screen.getByTestId(TEST_IDS.newsletterSignupInput)
    );
  });

  it('asks the browser for an email address it can autofill', () => {
    render(<NewsletterSignup />);
    const input = screen.getByLabelText('Email address');
    expect(input).toHaveAttribute('type', 'email');
    expect(input).toHaveAttribute('autocomplete', 'email');
  });

  it('shows no example address in the empty field', () => {
    render(<NewsletterSignup />);
    expect(screen.queryByPlaceholderText('you@example.com')).not.toBeInTheDocument();
  });

  it.each(VARIANTS)('stretches Subscribe across the form in the %s variant', (_label, compact) => {
    render(<NewsletterSignup compact={compact} />);
    expect(screen.getByTestId(TEST_IDS.newsletterSignupSubmit)).toHaveAttribute('data-block');
  });

  it.each(VARIANTS)('places Subscribe under the field in the %s variant', (_label, compact) => {
    render(<NewsletterSignup compact={compact} />);
    const input = screen.getByTestId(TEST_IDS.newsletterSignupInput);
    const submit = screen.getByTestId(TEST_IDS.newsletterSignupSubmit);
    expect(submit.parentElement).toBe(input.closest('form'));
  });

  it('shows no title line in the full variant', () => {
    render(<NewsletterSignup />);
    expect(screen.queryByText('Join our newsletter')).not.toBeInTheDocument();
  });

  it('renders the Subscribe submit button with its test id', () => {
    render(<NewsletterSignup />);
    const button = screen.getByTestId(TEST_IDS.newsletterSignupSubmit);
    expect(button).toHaveTextContent('Subscribe');
  });

  it('omits the line "One confirmation email, then you\'re in." under the full variant', () => {
    render(<NewsletterSignup />);
    expect(screen.queryByText("One confirmation email, then you're in.")).not.toBeInTheDocument();
  });

  it('shows the centered one-line pitch without the line "One confirmation email, then you\'re in." in the compact variant', () => {
    render(<NewsletterSignup compact />);
    const pitch = screen.getByText('Join our newsletter');
    expect(pitch).toBeInTheDocument();
    expect(pitch).toHaveClass('text-center');
    expect(screen.queryByText("One confirmation email, then you're in.")).not.toBeInTheDocument();
  });

  it('renders the default Subscribe button in the compact variant', () => {
    render(<NewsletterSignup compact />);
    expect(screen.getByTestId(TEST_IDS.newsletterSignupSubmit)).toHaveAttribute(
      'data-variant',
      'default'
    );
  });

  it.each([
    ['full', false],
    ['compact', true],
  ] as const)('renders its children inside the form in the %s variant', (_label, compact) => {
    render(
      <NewsletterSignup compact={compact}>
        <p>{CHILD_TEXT}</p>
      </NewsletterSignup>
    );
    expect(screen.getByText(CHILD_TEXT).closest('form')).not.toBeNull();
  });

  it.each(VARIANTS)(
    'shows the consent line and its Privacy Policy link under Subscribe in the %s variant',
    (_label, compact) => {
      render(
        <NewsletterSignup compact={compact}>
          <p>
            {CHILD_TEXT} <a href={ROUTES.PRIVACY}>Privacy Policy</a>
          </p>
        </NewsletterSignup>
      );
      const submit = screen.getByTestId(TEST_IDS.newsletterSignupSubmit);
      const link = screen.getByRole('link', { name: 'Privacy Policy' });
      expect(link).toHaveAttribute('href', ROUTES.PRIVACY);
      expect(submit.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  );

  it('drops its children from the success state', async () => {
    render(
      <NewsletterSignup>
        <p>{CHILD_TEXT}</p>
      </NewsletterSignup>
    );
    await submitValidEmail();
    await findSentHeading();
    expect(screen.queryByText(CHILD_TEXT)).not.toBeInTheDocument();
  });

  it.each([
    ['full', false],
    ['compact', true],
  ] as const)('renders no Privacy Policy link of its own in the %s variant', (_label, compact) => {
    const { container } = render(<NewsletterSignup compact={compact} />);
    expect(container.querySelector(`a[href="${ROUTES.PRIVACY}"]`)).toBeNull();
  });

  it('does not mark the input invalid before a failed submit', () => {
    render(<NewsletterSignup />);
    expect(screen.getByTestId(TEST_IDS.newsletterSignupInput)).not.toHaveAttribute('aria-invalid');
  });

  it('marks the input invalid and links the error message for assistive tech', async () => {
    const user = userEvent.setup();
    render(<NewsletterSignup />);
    await user.type(screen.getByTestId(TEST_IDS.newsletterSignupInput), 'not-an-email');
    await user.click(screen.getByTestId(TEST_IDS.newsletterSignupSubmit));
    const input = screen.getByTestId(TEST_IDS.newsletterSignupInput);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(INVALID_TEXT);
  });

  it("shows the error in the field's own message row", async () => {
    const user = userEvent.setup();
    render(<NewsletterSignup />);
    await user.type(screen.getByTestId(TEST_IDS.newsletterSignupInput), 'not-an-email');
    await user.click(screen.getByTestId(TEST_IDS.newsletterSignupSubmit));
    const input = screen.getByTestId(TEST_IDS.newsletterSignupInput);
    const row = document.querySelector(`[id="${input.id}-message"]`);
    expect(row).toContainElement(screen.getByRole('alert'));
  });

  it.each(VARIANTS)(
    "starts the form's text at its leading edge inside a centred page section in the %s variant",
    (_label, compact) => {
      const { container } = render(<NewsletterSignup compact={compact} />);
      expect(container.querySelector('form')).toHaveClass('text-start');
    }
  );

  it('rejects an invalid email with a validation message and no request', async () => {
    const fetchMock = mockFetch({ ok: true, status: 200 });
    const user = userEvent.setup();
    render(<NewsletterSignup />);
    await user.type(screen.getByTestId(TEST_IDS.newsletterSignupInput), 'not-an-email');
    await user.click(screen.getByTestId(TEST_IDS.newsletterSignupSubmit));
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a valid email address.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the validation message once a corrected email is submitted', async () => {
    const user = userEvent.setup();
    render(<NewsletterSignup />);
    await user.type(screen.getByTestId(TEST_IDS.newsletterSignupInput), 'nope');
    await user.click(screen.getByTestId(TEST_IDS.newsletterSignupSubmit));
    await user.clear(screen.getByTestId(TEST_IDS.newsletterSignupInput));
    await submitValidEmail();
    await findSentHeading();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('POSTs the email as JSON to /newsletter/subscribe', async () => {
    const fetchMock = mockFetch({ ok: true, status: 200 });
    render(<NewsletterSignup />);
    await submitValidEmail();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/newsletter/subscribe');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ email: 'reader@example.com' }));
  });

  // Enumeration safety is server-side; the UI pins one identical outcome for
  // every response so a probe can never read list membership off the screen.
  it.each([
    ['ok', { ok: true, status: 200 }] as const,
    ['server error', { ok: false, status: 500 }] as const,
    ['rate limited', { ok: false, status: 429 }] as const,
    ['network failure', 'reject'] as const,
  ])('shows the identical success state on %s', async (_label, response) => {
    mockFetch(response);
    render(<NewsletterSignup />);
    await submitValidEmail();
    await findSentHeading();
    expect(screen.getByText(SENT_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.newsletterSignupInput)).not.toBeInTheDocument();
  });

  describe.each(VARIANTS)('the sent state in the %s variant', (_label, compact) => {
    async function renderSent(): Promise<HTMLElement> {
      render(<NewsletterSignup compact={compact} />);
      await submitValidEmail();
      return findSentHeading();
    }

    it('says to confirm through the emailed link', async () => {
      await renderSent();
      expect(screen.getByText(SENT_TEXT)).toBeInTheDocument();
    });

    it('announces itself as a status region holding the heading', async () => {
      const heading = await renderSent();
      expect(screen.getByRole('status')).toContainElement(heading);
    });

    it('draws a decorative mail icon in a round tile above the heading', async () => {
      const heading = await renderSent();
      const icon = screen.getByRole('status').querySelector('svg');
      expect(icon).not.toBeNull();
      expect(icon?.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(icon?.parentElement).toHaveClass('rounded-full');
      expect(
        (icon?.compareDocumentPosition(heading) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it('links "Read the blog" to the blog as the outline button', async () => {
      await renderSent();
      const link = screen.getByRole('link', { name: 'Read the blog' });
      expect(link).toHaveAttribute('href', ROUTES.BLOG);
      expect(link).toHaveAttribute('data-variant', 'outline');
    });

    it('links "Try HushBox Free" to the chat as the primary button', async () => {
      await renderSent();
      const link = screen.getByRole('link', { name: 'Try HushBox Free' });
      expect(link).toHaveAttribute('href', ROUTES.CHAT);
      expect(link).toHaveAttribute('data-variant', 'default');
    });

    it('sets the two buttons side by side in one row, blog first', async () => {
      await renderSent();
      const blog = screen.getByRole('link', { name: 'Read the blog' });
      const chat = screen.getByRole('link', { name: 'Try HushBox Free' });
      expect(blog.parentElement).toBe(chat.parentElement);
      expect(blog.nextElementSibling).toBe(chat);
    });

    it('marks itself as the sent state for the page around it', async () => {
      await renderSent();
      expect(screen.getByRole('status')).toHaveAttribute(NEWSLETTER_SENT_ATTRIBUTE);
    });

    it('drops the title line', async () => {
      await renderSent();
      expect(screen.queryByText('Join our newsletter')).not.toBeInTheDocument();
    });

    it('keeps the readiness signal', async () => {
      const { container } = render(<NewsletterSignup compact={compact} />);
      await submitValidEmail();
      await findSentHeading();
      expect(container.querySelector(`[${TEST_SIGNALS.newsletterReady}]`)).not.toBeNull();
    });
  });

  it('names the sent marker as a data attribute a stylesheet can select', () => {
    expect(NEWSLETTER_SENT_ATTRIBUTE).toMatch(/^data-[a-z-]+$/);
  });

  it('marks no sent state on the form', () => {
    const { container } = render(<NewsletterSignup />);
    expect(container.querySelector(`[${NEWSLETTER_SENT_ATTRIBUTE}]`)).toBeNull();
  });

  it.each(VARIANTS)(
    'sends no address with a native submit before hydration in the %s variant',
    (_label, compact) => {
      const host = document.createElement('div');
      host.innerHTML = renderToStaticMarkup(<NewsletterSignup compact={compact} />);
      const form = host.querySelector('form');
      const input = host.querySelector('input');
      if (form === null || input === null) throw new Error('the server markup renders no form');
      input.value = 'reader@example.com';
      const submitted = [...new FormData(form).values()].map(String);
      expect(submitted).not.toContain('reader@example.com');
    }
  );

  it.each(VARIANTS)(
    'puts no address in the query string a native submit before hydration would build in the %s variant',
    (_label, compact) => {
      const host = document.createElement('div');
      host.innerHTML = renderToStaticMarkup(<NewsletterSignup compact={compact} />);
      const form = host.querySelector('form');
      const input = host.querySelector('input');
      if (form === null || input === null) throw new Error('the server markup renders no form');
      input.value = 'reader@example.com';
      const query = new URLSearchParams(
        [...new FormData(form).entries()].map(([key, value]) => [
          key,
          typeof value === 'string' ? value : value.name,
        ])
      ).toString();
      expect(query).not.toContain('reader');
    }
  );

  it('emits the readiness signal once hydrated', async () => {
    const { container } = render(<NewsletterSignup />);
    await waitFor(() => {
      expect(container.querySelector(`[${TEST_SIGNALS.newsletterReady}]`)).not.toBeNull();
    });
  });

  it('hydrates without a mismatch after the growth script tags its links', async () => {
    const island = mountServerRenderedIsland();
    tagSameOriginLinks(island, 'spec-tag');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => {
        hydrateAstroIsland(island)(
          NewsletterSignup,
          { compact: true },
          { default: SLOT_HTML },
          { client: 'visible' }
        );
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(island.querySelector(`[${TEST_SIGNALS.newsletterReady}]`)).not.toBeNull();
      });
      const mismatches = consoleError.mock.calls.filter((call) =>
        call.some((argument) => String(argument).includes(HYDRATION_MISMATCH))
      );
      expect(mismatches).toEqual([]);
    } finally {
      consoleError.mockRestore();
      island.remove();
    }
  });

  it('does not carry the readiness signal in server-rendered markup', () => {
    const html = renderToStaticMarkup(<NewsletterSignup />);
    expect(html).not.toContain(TEST_SIGNALS.newsletterReady);
  });
});
