import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { PRIVACY_SECTIONS } from '@hushbox/shared/legal';
import { DEMO_SAMPLE_TEXT, encryptDemoSample } from '../lib/encryption-demo-sample';
import { PrivacyDocument } from './PrivacyDocument';
import type { DemoSample } from '../lib/encryption-demo-sample';

const ENCRYPTION_SAMPLE: DemoSample = encryptDemoSample(DEMO_SAMPLE_TEXT);

describe('PrivacyDocument', () => {
  it('shows the stored bytes of the sample it is given, so hydration keeps the server hex', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(screen.getByTestId(TEST_IDS.cipherOutput).textContent).toBe(ENCRYPTION_SAMPLE.hex);
  });

  it('renders the privacy section titles from shared content', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    for (const section of PRIVACY_SECTIONS) {
      expect(screen.getByRole('heading', { name: section.title })).toBeInTheDocument();
    }
  });

  it('renders the data-collection nutrition label footnotes', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(screen.getByText(/Sent to AI providers pseudonymously/)).toBeInTheDocument();
    expect(screen.getByText(/handled entirely by our payment processor/)).toBeInTheDocument();
  });

  it('renders the encryption-security data flow and live demo', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(screen.getByText('How your data flows through HushBox')).toBeInTheDocument();
    expect(screen.getByText('See it for yourself')).toBeInTheDocument();
    expect(screen.getByText('How we compare')).toBeInTheDocument();
  });
});

function rowNamed(label: string): HTMLElement {
  const header = screen.getByRole('rowheader', { name: label });
  const row = header.closest('tr');
  if (row === null) throw new Error(`no row for ${label}`);
  return row;
}

function rowTexts(label: string): readonly string[] {
  const row = rowNamed(label);
  return [
    within(row).getByRole('rowheader').textContent,
    ...within(row)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ];
}

function kindsOf(label: string): readonly (string | null)[] {
  return within(rowNamed(label))
    .getAllByRole('cell')
    .map(
      (cell) => cell.querySelector<HTMLElement>('[data-slot="value-mark"]')?.dataset['kind'] ?? null
    );
}

function tableHolding(rowLabel: string): HTMLTableElement {
  const table = rowNamed(rowLabel).closest('table');
  if (table === null) throw new Error(`no table holds ${rowLabel}`);
  return table;
}

function layoutOf(rowLabel: string): string | null | undefined {
  return tableHolding(rowLabel).closest<HTMLElement>('[data-slot="data-table"]')?.dataset['layout'];
}

const ANSWER_GLYPHS = /[\u2713\u2717\u26A0]|\uD83D\uDD12/u;

describe('PrivacyDocument nutrition label', () => {
  it('carries the acquisition source the data-collection section discloses', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(rowTexts('Acquisition Source')).toEqual([
      'Acquisition Source',
      'Yes',
      'With your account',
      'No',
    ]);
  });

  it('carries the time zone the notification-settings point discloses', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(rowTexts('Time Zone')).toEqual([
      'Time Zone',
      'If you set quiet hours',
      'With your account',
      'No',
    ]);
  });

  it('describes the stored address as scrambled with two records keeping it', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(rowTexts('IP Address')).toEqual([
      'IP Address',
      'Yes',
      'Scrambled; two records keep it***',
      'Seen by Cloudflare and our payment processor',
    ]);
  });

  it('carries the feedback reports the data-collection section discloses', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(rowTexts('Feedback')).toEqual([
      'Feedback',
      'If you send it',
      'Readable, with your account',
      'No',
    ]);
  });

  it('places the feedback row between the IP address row and the time zone row', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    const labels = within(tableHolding('Feedback'))
      .getAllByRole('rowheader')
      .map((header) => header.textContent);
    const feedback = labels.indexOf('Feedback');
    expect(labels.slice(feedback - 1, feedback + 2)).toEqual([
      'IP Address',
      'Feedback',
      'Time Zone',
    ]);
  });

  it('gives each record that keeps the address its own lifetime in the address footnote', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    const footnote = screen.getByText(/^\*\*\* /);
    expect(footnote.textContent).toBe(
      '*** Rate limiting and website counting keep only a scrambled form, in a cache separate from our database. Two records keep the address itself: your mailing-list consent evidence if you subscribe, kept as long as that record exists, and the account-deletion record, which keeps it for 90 days. Card payments also pass it to our payment processor.'
    );
  });

  it('does not leave the ninety-day bound trailing the whole list of records', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    const footnote = screen.getByText(/^\*\*\* /);
    expect(footnote.textContent).not.toContain('and the account-deletion record, for 90 days');
  });

  it('states in the payment row what the payment record keeps of the card', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(rowTexts('Payment Info')).toEqual([
      'Payment Info',
      'Card brand and last four',
      'Amounts, dates, brand and last four**',
      'No',
    ]);
  });

  it('names what the payment records hold in the payment footnote', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    const footnote = screen.getByText(/^\*\* /);
    expect(footnote.textContent).toBe(
      '** Card numbers and bank details are handled entirely by our payment processor and are never stored here. The amounts, the dates, and the card\u2019s brand and last four digits stay in our billing records, as described under Data Retention & Deletion, with your account link removed when you delete your account.'
    );
  });

  it('does not describe the stored address as consent-only', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(screen.queryByText(/Consent only/)).toBeNull();
  });

  it('lists every category the data-collection section discloses, in its order', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(
      within(tableHolding('Email'))
        .getAllByRole('rowheader')
        .map((header) => header.textContent)
    ).toEqual([
      'Email',
      'Username',
      'Acquisition Source',
      'Messages',
      'IP Address',
      'Feedback',
      'Time Zone',
      'Payment Info',
    ]);
  });

  it('heads the nutrition label with its data column and its three answers', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(
      within(tableHolding('Email'))
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
    ).toEqual(['Data', 'Collected', 'Stored', 'Shared']);
  });

  it('carries the email the account-information point discloses', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(rowTexts('Email')).toEqual(['Email', 'Yes', 'Yes', 'To Resend, to send it']);
  });

  it('carries the username the account-information point discloses', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(rowTexts('Username')).toEqual(['Username', 'Yes', 'Yes', 'No']);
  });

  it('carries the messages the message-content point discloses', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(rowTexts('Messages')).toEqual(['Messages', 'Yes', 'Encrypted', 'To AI*']);
  });

  it.each([
    ['Email', ['yes', 'yes', 'warn']],
    ['Username', ['yes', 'yes', 'no']],
    ['Acquisition Source', ['yes', 'yes', 'no']],
    ['Messages', ['yes', 'lock', 'warn']],
    ['IP Address', ['yes', 'warn', 'warn']],
    ['Feedback', ['yes', 'warn', 'no']],
    ['Time Zone', ['yes', 'yes', 'no']],
    ['Payment Info', ['warn', 'warn', 'no']],
  ])('marks each answer in the %s row with its kind', (label, kinds) => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(kindsOf(label)).toEqual(kinds);
  });

  it('stacks the nutrition label into labelled lines on phones', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(layoutOf('Email')).toBe('stack');
  });
});

describe('PrivacyDocument answers', () => {
  it('sets every grid in the interface face, as the site sets its data', () => {
    const { container } = render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    const tables = [...container.querySelectorAll('table')];
    expect(tables).toHaveLength(3);
    for (const table of tables) {
      expect(table.closest('.font-sans')).not.toBeNull();
    }
  });

  it('names no answer by a glyph character, only by a mark and its word', () => {
    const { container } = render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    for (const table of container.querySelectorAll('table')) {
      expect(table.textContent).not.toMatch(ANSWER_GLYPHS);
    }
  });
});

function dataFlowList(): HTMLElement {
  const list = screen.getByText('You type a message', { selector: 'p' }).closest('ol');
  if (list === null) throw new Error('the data flow is not an ordered list');
  return list;
}

function dataFlowDescription(title: string): string | null | undefined {
  return screen.getByText(title, { selector: 'p' }).nextElementSibling?.textContent;
}

describe('PrivacyDocument data flow', () => {
  it('states that the servers cannot decrypt the stored blobs', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(dataFlowDescription('Stored as encrypted blobs')).toBe(
      'Our servers CANNOT decrypt them, even if we wanted to.'
    );
  });

  it('names who can read the messages once decrypted in the browser', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(dataFlowDescription('Decrypted in your browser')).toBe(
      'Using your private key, derived from your password. Only you, and anyone you share the conversation with, can read your messages.'
    );
  });

  it('highlights the sixth step, where the servers cannot decrypt what they store', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    const steps = within(dataFlowList()).getAllByRole('listitem');
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual([
      null,
      null,
      null,
      null,
      null,
      'step',
      null,
      null,
    ]);
  });

  it('carries the no-decrypt line on the highlighted step', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    const current = within(dataFlowList())
      .getAllByRole('listitem')
      .find((step) => step.getAttribute('aria-current') === 'step');
    expect(current?.textContent).toContain(
      'Our servers CANNOT decrypt them, even if we wanted to.'
    );
  });

  it('draws the steps without an animation state', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    const flow = dataFlowList();
    expect(flow).not.toHaveAttribute('data-animated');
    expect(flow).not.toHaveAttribute('data-visible');
  });
});

describe('PrivacyDocument comparison', () => {
  it('answers each comparison row in words', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(
      ['Messages stored encrypted', 'Provider can read your chats', 'Password sent to server'].map(
        (label) => rowTexts(label)
      )
    ).toEqual([
      ['Messages stored encrypted', 'Plaintext', 'Encrypted'],
      ['Provider can read your chats', 'Yes', 'No'],
      ['Password sent to server', 'Yes', 'Never'],
    ]);
  });

  it('draws no value mark in the comparison', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(kindsOf('Provider can read your chats')).toEqual([null, null]);
  });

  it('heads the comparison with the two apps it compares', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(
      within(tableHolding('Password sent to server'))
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
    ).toEqual(['Item', 'Your current AI chat app', 'HushBox']);
  });

  it('tints the HushBox column, its head and every answer', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    const table = tableHolding('Password sent to server');
    expect([...table.querySelectorAll('[data-highlight]')].map((cell) => cell.textContent)).toEqual(
      ['HushBox', 'Encrypted', 'No', 'Never']
    );
  });

  it('stacks the comparison into labelled lines on phones', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(layoutOf('Password sent to server')).toBe('stack');
  });
});

function measurementGrid(): HTMLTableElement {
  return tableHolding('Pages you visit');
}

function measurementColumns(): readonly string[] {
  return within(measurementGrid())
    .getAllByRole('columnheader')
    .map((header) => header.textContent);
}

function measurementRows(): readonly (readonly string[])[] {
  return within(measurementGrid())
    .getAllByRole('row')
    .filter((row) => within(row).queryAllByRole('cell').length > 0)
    .map((row) => [
      within(row).getByRole('rowheader').textContent,
      ...within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ]);
}

describe('PrivacyDocument measurement grid', () => {
  it('heads the measurement grid with the three approved columns', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(measurementColumns()).toEqual([
      'What the counter takes',
      'How long we keep it',
      'Tied to your account',
    ]);
  });

  it('lists what the website counter takes in the approved order', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(measurementRows()).toEqual([
      ['Pages you visit', 'Counts, kept indefinitely', 'No'],
      ['The site that linked you', 'Counts, kept indefinitely', 'No'],
      ['Campaign tag in your link', 'Counts, kept indefinitely', 'No'],
      ['Country and US state', 'Counts, kept indefinitely', 'No'],
      ['Device family', 'Counts, kept indefinitely', 'No'],
      ['Links clicked, scroll depth', 'Counts, kept indefinitely', 'No'],
      ['Your daily visitor code', 'Cache only, cleared within two and a half days', 'No'],
      ['Account signups started', 'Counts, kept indefinitely', 'No'],
      ['Scrambled address behind signup counts', 'Cache only, cleared on the same schedule', 'No'],
      ['Which page you moved to next', 'Counts, kept indefinitely', 'No'],
    ]);
  });

  it('marks every tied-to-your-account answer as a no, and leaves the keeping words plain', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    for (const label of [
      'Pages you visit',
      'Your daily visitor code',
      'Which page you moved to next',
    ]) {
      expect(kindsOf(label)).toEqual([null, 'no']);
    }
  });

  it('stacks the measurement grid into labelled lines on phones', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(layoutOf('Pages you visit')).toBe('stack');
  });

  it('shows the measurement grid without the reader expanding anything', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(screen.getByRole('rowheader', { name: 'Country and US state' })).toBeVisible();
  });

  it('keeps the measurement section detail collapsed by default', () => {
    render(<PrivacyDocument encryptionSample={ENCRYPTION_SAMPLE} />);
    expect(screen.getByText(/the country, the US state, and the device family/)).not.toBeVisible();
  });
});

describe('the site stylesheet', () => {
  const css = readFileSync(path.resolve(__dirname, '../styles/global.css'), 'utf8');

  it('holds no hidden state for a privacy grid row or a data-flow step, so both show without script', () => {
    expect(css).not.toMatch(/\[data-slot='(data-grid|step-flow)'\]\[data-animated\]/);
  });

  it('keeps no keyframes for the privacy grids or the data flow', () => {
    expect(css).not.toMatch(/@keyframes (rowReveal|lineGrow)\b/);
  });
});
