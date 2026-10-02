import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  TEST_DAY_START,
  isoAt,
} from '@hushbox/shared/test-time';
import { requestUrl } from '@/test-utils/request-url';
import { opCatalog } from '@/test-utils/op-catalog';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { ComposePanel, toUtcIso } from './compose-panel.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = opCatalog('newsletter.schedule', 'newsletter.testSend');

function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('/admin/ops')) {
        return Promise.resolve(Response.json(CATALOG));
      }
      return Promise.resolve(Response.json({ html: '<p>preview</p>' }));
    })
  );
}

function renderPanel(): void {
  stubApi();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <ComposePanel />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

async function fillDraft(): Promise<void> {
  await userEvent.type(screen.getByTestId(TEST_IDS.adminNewsletterSubject), 'July notes');
  await userEvent.type(screen.getByTestId(TEST_IDS.adminNewsletterBody), '# hello');
}

/** Years past the anchor, because the picker only accepts a future minute. */
const SCHEDULE_MS = TEST_DAY_START + 1461 * DAY_MS + 9 * HOUR_MS + 30 * MINUTE_MS;
/** What the `datetime-local` control hands back: minutes precision, no zone. */
const PICKER_MINUTES = isoAt(SCHEDULE_MS).slice(0, 16);
const PICKER_SECONDS = `${PICKER_MINUTES}:15`;

describe('toUtcIso', () => {
  it('converts a minutes-precision picker value to a UTC ISO instant', () => {
    expect(toUtcIso(PICKER_MINUTES)).toBe(isoAt(SCHEDULE_MS));
  });

  it('converts a seconds-bearing picker value without corrupting the instant', () => {
    expect(toUtcIso(PICKER_SECONDS)).toBe(isoAt(SCHEDULE_MS + 15 * SECOND_MS));
  });
});

describe('ComposePanel', () => {
  it('renders subject, markdown body, and UTC schedule picker fields', () => {
    renderPanel();
    expect(screen.getByTestId(TEST_IDS.adminNewsletterSubject)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminNewsletterBody)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminNewsletterScheduledAt)).toBeInTheDocument();
    expect(screen.getByText(/UTC/)).toBeInTheDocument();
  });

  it('draws the subject as the inline input, named by its label', () => {
    renderPanel();
    expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveAttribute(
      'data-slot',
      'inline-input'
    );
  });

  it('draws the send time as the inline input, named by its label', () => {
    renderPanel();
    expect(screen.getByLabelText('Send at (UTC)')).toHaveAttribute('data-slot', 'inline-input');
  });

  it('keeps the body named by its label', () => {
    renderPanel();
    expect(screen.getByRole('textbox', { name: 'Body (markdown)' })).toBe(
      screen.getByTestId(TEST_IDS.adminNewsletterBody)
    );
  });

  it('renders no reason field of its own, since the OpModal collects one', () => {
    renderPanel();
    expect(screen.queryByLabelText('Reason')).not.toBeInTheDocument();
  });

  it('keeps Schedule disabled until the full draft is present', async () => {
    renderPanel();
    const schedule = screen.getByTestId(TEST_IDS.adminNewsletterSchedule);
    expect(schedule).toBeDisabled();
    await fillDraft();
    expect(schedule).toBeDisabled();
    await userEvent.type(screen.getByTestId(TEST_IDS.adminNewsletterScheduledAt), PICKER_MINUTES);
    expect(schedule).toBeEnabled();
  });

  it('launches newsletter.schedule through the OpModal with the draft prefilled as UTC ISO', async () => {
    renderPanel();
    await fillDraft();
    await userEvent.type(screen.getByTestId(TEST_IDS.adminNewsletterScheduledAt), PICKER_MINUTES);
    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterSchedule));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Schedule newsletter issue')).toBeInTheDocument();
    expect(within(modal).getByLabelText('subject')).toHaveValue('July notes');
    expect(within(modal).getByLabelText('bodyMarkdown')).toHaveValue('# hello');
    expect(within(modal).getByLabelText('scheduledAt')).toHaveValue(isoAt(SCHEDULE_MS));
    expect(within(modal).getByLabelText('reason')).toHaveValue('');
  });

  it('launches newsletter.testSend through the OpModal with the draft prefilled', async () => {
    renderPanel();
    await fillDraft();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterTestSend));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Send newsletter test email')).toBeInTheDocument();
    expect(within(modal).getByLabelText('subject')).toHaveValue('July notes');
    expect(within(modal).getByLabelText('bodyMarkdown')).toHaveValue('# hello');
    expect(within(modal).getByLabelText('reason')).toHaveValue('');
  });

  it('keeps Send-test disabled until subject and body are present', async () => {
    renderPanel();
    const testSend = screen.getByTestId(TEST_IDS.adminNewsletterTestSend);
    expect(testSend).toBeDisabled();
    await userEvent.type(screen.getByTestId(TEST_IDS.adminNewsletterSubject), 'July notes');
    await userEvent.type(screen.getByTestId(TEST_IDS.adminNewsletterBody), '# hello');
    expect(testSend).toBeEnabled();
  });
});
