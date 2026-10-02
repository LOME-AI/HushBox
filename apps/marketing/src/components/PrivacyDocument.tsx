import * as React from 'react';
import { PRIVACY_POLICY_META, PRIVACY_SECTIONS } from '@hushbox/shared/legal';
import { DataTable, type DataCell } from './ui/data-table';
import { StepFlow } from './ui/step-flow';
import { LegalDocument } from './LegalDocument';
import { EncryptionDemo } from './encryption-demo';
import type { ValueCell } from './ui/value-mark';
import type { DemoSample } from '../lib/encryption-demo-sample';

const NUTRITION_LABEL_COLUMNS = ['Collected', 'Stored', 'Shared'];

function yes(text: string): ValueCell {
  return { kind: 'yes', text };
}

function warn(text: string): ValueCell {
  return { kind: 'warn', text };
}

const NO: ValueCell = { kind: 'no', text: 'No' };

// A skimming reader takes this grid for the whole of the section above it, so it carries a row
// per category that section discloses, in that section's order. A cell is judged by what a
// visitor takes from it, not by its mark alone: where the two part, the cell names its scope
// and its footnote carries what the rest of the policy holds.
const NUTRITION_LABEL_ROWS: readonly { label: string; cells: readonly DataCell[] }[] = [
  { label: 'Email', cells: [yes('Yes'), yes('Yes'), warn('To Resend, to send it')] },
  { label: 'Username', cells: [yes('Yes'), yes('Yes'), NO] },
  { label: 'Acquisition Source', cells: [yes('Yes'), yes('With your account'), NO] },
  {
    label: 'Messages',
    cells: [yes('Yes'), { kind: 'lock', text: 'Encrypted' }, warn('To AI*')],
  },
  {
    label: 'IP Address',
    cells: [
      yes('Yes'),
      warn('Scrambled; two records keep it***'),
      warn('Seen by Cloudflare and our payment processor'),
    ],
  },
  { label: 'Feedback', cells: [yes('If you send it'), warn('Readable, with your account'), NO] },
  { label: 'Time Zone', cells: [yes('If you set quiet hours'), yes('With your account'), NO] },
  {
    label: 'Payment Info',
    cells: [warn('Card brand and last four'), warn('Amounts, dates, brand and last four**'), NO],
  },
];

const DATA_FLOW_STEPS = [
  {
    title: 'You type a message',
    description: 'Your words, your keyboard, your device.',
  },
  {
    title: 'Sent securely over HTTPS',
    description: 'Standard TLS encryption in transit.',
  },
  {
    title: 'HushBox routes to AI model',
    description: 'Using our credentials, not yours. Pseudonymous.',
  },
  {
    title: 'AI responds',
    description: 'The model generates a response to your prompt.',
  },
  {
    title: 'Both messages encrypted',
    description: "Encrypted with your conversation's public key.",
  },
  {
    title: 'Stored as encrypted blobs',
    description: 'Our servers CANNOT decrypt them, even if we wanted to.',
  },
  {
    title: 'You fetch the encrypted data',
    description: 'Downloaded to your browser over HTTPS.',
  },
  {
    title: 'Decrypted in your browser',
    description:
      'Using your private key, derived from your password. Only you, and anyone you share the conversation with, can read your messages.',
  },
];

const MEASUREMENT_COLUMNS = ['How long we keep it', 'Tied to your account'];

const KEPT_AS_COUNTS = 'Counts, kept indefinitely';

// A grid of its own rather than rows in {@link NUTRITION_LABEL_ROWS}: that grid's membership is
// pinned to the Data We Collect section in both directions, and its account-shaped columns have
// no honest value for measurements deliberately tied to no account.
const MEASUREMENT_ROWS: readonly { label: string; cells: readonly DataCell[] }[] = [
  { label: 'Pages you visit', cells: [KEPT_AS_COUNTS, NO] },
  { label: 'The site that linked you', cells: [KEPT_AS_COUNTS, NO] },
  { label: 'Campaign tag in your link', cells: [KEPT_AS_COUNTS, NO] },
  { label: 'Country and US state', cells: [KEPT_AS_COUNTS, NO] },
  { label: 'Device family', cells: [KEPT_AS_COUNTS, NO] },
  { label: 'Links clicked, scroll depth', cells: [KEPT_AS_COUNTS, NO] },
  {
    label: 'Your daily visitor code',
    cells: ['Cache only, cleared within two and a half days', NO],
  },
  { label: 'Account signups started', cells: [KEPT_AS_COUNTS, NO] },
  {
    label: 'Scrambled address behind signup counts',
    cells: ['Cache only, cleared on the same schedule', NO],
  },
  { label: 'Which page you moved to next', cells: [KEPT_AS_COUNTS, NO] },
];

const COMPARISON_COLUMNS = ['Your current AI chat app', 'HushBox'];

const COMPARISON_ROWS: readonly { label: string; cells: readonly DataCell[] }[] = [
  { label: 'Messages stored encrypted', cells: ['Plaintext', 'Encrypted'] },
  { label: 'Provider can read your chats', cells: ['Yes', 'No'] },
  { label: 'Password sent to server', cells: ['Yes', 'Never'] },
];

function renderAfterSection(sectionId: string, encryptionSample: DemoSample): React.JSX.Element {
  if (sectionId === 'data-collection') {
    return (
      <div className="mt-2 flex flex-col gap-3">
        <h4 className="sr-only">Privacy Nutrition Label</h4>
        <DataTable
          layout="stack"
          caption="Privacy Nutrition Label"
          columns={NUTRITION_LABEL_COLUMNS}
          rowHeaderLabel="Data"
          showRowHeaderLabel
          rows={NUTRITION_LABEL_ROWS}
        />
        <div className="text-muted-foreground text-xs">
          <p>* Sent to AI providers pseudonymously</p>
          <p>
            ** Card numbers and bank details are handled entirely by our payment processor and are
            never stored here. The amounts, the dates, and the card{'\u2019'}s brand and last four
            digits stay in our billing records, as described under Data Retention &amp; Deletion,
            with your account link removed when you delete your account.
          </p>
          <p>
            *** Rate limiting and website counting keep only a scrambled form, in a cache separate
            from our database. Two records keep the address itself: your mailing-list consent
            evidence if you subscribe, kept as long as that record exists, and the account-deletion
            record, which keeps it for 90 days. Card payments also pass it to our payment processor.
          </p>
        </div>
      </div>
    );
  }

  if (sectionId === 'encryption-security') {
    return (
      <div className="mt-2 flex flex-col gap-8">
        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-semibold">How your data flows through HushBox</h4>
          <StepFlow steps={DATA_FLOW_STEPS} connected highlightStep={5} />
        </div>

        <EncryptionDemo initialSample={encryptionSample} />

        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-semibold">How we compare</h4>
          <DataTable
            layout="stack"
            caption="How HushBox compares with your current AI chat app"
            columns={COMPARISON_COLUMNS}
            rowHeaderLabel="Item"
            rows={COMPARISON_ROWS}
            highlightColumn={1}
          />
        </div>
      </div>
    );
  }

  if (sectionId === 'website-measurement') {
    return (
      <div className="mt-2">
        <DataTable
          layout="stack"
          caption="What the website counter takes"
          columns={MEASUREMENT_COLUMNS}
          rowHeaderLabel="What the counter takes"
          showRowHeaderLabel
          rows={MEASUREMENT_ROWS}
        />
      </div>
    );
  }

  return <></>;
}

export function PrivacyDocument({
  encryptionSample,
}: Readonly<{ encryptionSample: DemoSample }>): React.JSX.Element {
  return (
    <LegalDocument
      meta={PRIVACY_POLICY_META}
      sections={PRIVACY_SECTIONS}
      renderAfterSection={(sectionId) => renderAfterSection(sectionId, encryptionSample)}
    />
  );
}
