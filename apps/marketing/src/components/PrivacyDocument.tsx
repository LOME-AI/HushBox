import * as React from 'react';
import { LegalDocument } from './LegalDocument';
import { PRIVACY_POLICY_META, PRIVACY_SECTIONS } from '@hushbox/shared/legal';
import { DataGrid, StepFlow, EncryptionDemo } from '@hushbox/ui';

const NUTRITION_LABEL_COLUMNS = ['Data', 'Collected', 'Stored', 'Shared'];

const NUTRITION_LABEL_ROWS = [
  { label: 'Email', values: ['\u2713 Yes', '\u2713 Yes', '\u2717 No'] },
  { label: 'Username', values: ['\u2713 Yes', '\u2713 Yes', '\u2717 No'] },
  {
    label: 'Messages',
    values: ['\u2713 Yes', '\uD83D\uDD12 Encrypted', '\u26A0 To AI*'],
  },
  {
    label: 'IP Address',
    values: ['\u231B Transient', '\u2717 No', '\u2717 No'],
  },
  {
    label: 'Payment Info',
    values: ['\u2717 No**', '\u2717 No', '\u2717 No'],
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
    description: 'Our servers CANNOT decrypt them \u2014 even if we wanted to.',
  },
  {
    title: 'You fetch the encrypted data',
    description: 'Downloaded to your browser over HTTPS.',
  },
  {
    title: 'Decrypted in your browser',
    description:
      'Using your private key, derived from your password. Only you can read your messages.',
  },
];

const COMPARISON_COLUMNS = ['', 'Your current AI chat app', 'HushBox'];

const COMPARISON_ROWS = [
  {
    label: 'Messages stored encrypted',
    values: ['Plaintext', 'Encrypted'],
  },
  {
    label: 'Provider can read your chats',
    values: ['Yes', 'No'],
  },
  {
    label: 'Password sent to server',
    values: ['Yes', 'Never'],
  },
];

function renderAfterSection(sectionId: string): React.JSX.Element {
  if (sectionId === 'data-collection') {
    return (
      <div className="mt-6 space-y-2">
        <h4 className="sr-only">Privacy Nutrition Label</h4>
        <DataGrid
          animated
          className="overflow-hidden"
          columns={NUTRITION_LABEL_COLUMNS}
          rows={NUTRITION_LABEL_ROWS}
        />
        <div className="text-muted-foreground text-xs">
          <p>* Sent to AI providers pseudonymously</p>
          <p>** Handled entirely by payment processor</p>
        </div>
      </div>
    );
  }

  if (sectionId === 'encryption-security') {
    return (
      <div className="mt-6 space-y-8">
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">How your data flows through HushBox</h4>
          <StepFlow steps={DATA_FLOW_STEPS} connected animated highlightStep={5} />
        </div>

        <EncryptionDemo />

        <div className="space-y-2">
          <h4 className="text-sm font-semibold">How we compare</h4>
          <DataGrid
            animated
            className="overflow-hidden"
            columns={COMPARISON_COLUMNS}
            rows={COMPARISON_ROWS}
            highlightColumn={2}
          />
        </div>
      </div>
    );
  }

  return <></>;
}

export function PrivacyDocument(): React.JSX.Element {
  return (
    <LegalDocument
      meta={PRIVACY_POLICY_META}
      sections={PRIVACY_SECTIONS}
      renderAfterSection={renderAfterSection}
    />
  );
}
