import { Heading, Text } from '@hushbox/ui/type';
import type * as React from 'react';
import type { TypeRole } from '@hushbox/shared/design-tokens';
import type { KitSection } from './kit-sections';

interface Sample {
  role: TypeRole;
  text: string;
  heading?: 2 | 3 | 4;
}

const HEADINGS: readonly Sample[] = [
  { role: 'display-1', text: 'Private AI chat', heading: 2 },
  { role: 'display-2', text: 'Private AI chat', heading: 3 },
  { role: 'title-1', text: 'Where does my money go?', heading: 3 },
  { role: 'title-2', text: 'How billing works', heading: 3 },
  { role: 'title-3', text: 'Current Balance', heading: 4 },
  { role: 'title-3-read', text: 'Why replies are encrypted', heading: 4 },
  { role: 'auth-title', text: 'Two-Factor Authentication', heading: 3 },
  { role: 'header-title', text: 'Lisbon trip planning', heading: 4 },
  { role: 'chat-greeting', text: 'Good morning', heading: 2 },
];

const SITE_HEADINGS: readonly Sample[] = [
  { role: 'site-hero', text: 'Every model. One private place.', heading: 2 },
  { role: 'site-section', text: 'Encrypted before it is stored', heading: 3 },
  { role: 'site-title', text: "You're unsubscribed.", heading: 3 },
  { role: 'site-post-title', text: 'Why we encrypt your chats', heading: 3 },
  { role: 'site-lead', text: 'Pay for what you use', heading: 3 },
  { role: 'site-value', text: 'No subscription', heading: 4 },
  { role: 'site-subhead', text: 'What we never see', heading: 4 },
  { role: 'site-trust', text: 'Zero-Knowledge Password', heading: 4 },
  { role: 'site-card-title', text: 'Custom system prompts', heading: 4 },
];

const TEXT: readonly Sample[] = [
  {
    role: 'lead',
    text: 'Every model, one place. Your chats are encrypted before they are stored.',
  },
  { role: 'body', text: 'A reply in Merriweather at 16px, set for reading.' },
  { role: 'body-lg', text: 'Long-form reading that steps up a size from 768.' },
  { role: 'body-sub', text: 'Reasoning that sits beneath the answer, muted.' },
  { role: 'ui-lg', text: 'Interface text, large' },
  { role: 'ui', text: 'Interface text in Hanken Grotesk at 14px.' },
  { role: 'ui-snug', text: 'Save and reuse prompt presets' },
  { role: 'ui-sm', text: 'Interface text, small' },
  { role: 'caption', text: 'Caption, 12px, muted.' },
  { role: 'mono', text: 'const key = await deriveKey(phrase);' },
  { role: 'mono-sm', text: '3 of 4 in progress' },
  { role: 'site-cipher', text: '020cee205f0d18edc0f1d0add308868e' },
  { role: 'num', text: '$12.48 · 1,862 tokens' },
  { role: 'tabular', text: '$0.0041' },
];

const TONES = ['muted', 'signal', 'error', 'success', 'warning'] as const;

function RoleList({ samples }: Readonly<{ samples: readonly Sample[] }>): React.JSX.Element {
  return (
    <dl className="flex min-w-0 flex-col gap-4">
      {samples.map((sample) => (
        <div key={sample.role} className="flex min-w-0 flex-col gap-1">
          <Text variant="caption" as="dt">
            {sample.role}
          </Text>
          <dd className="min-w-0 wrap-break-word">
            {sample.heading === undefined ? (
              <Text variant={sample.role} as="span">
                {sample.text}
              </Text>
            ) : (
              <Heading level={sample.heading} variant={sample.role}>
                {sample.text}
              </Heading>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Group({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Text variant="ui-sm" tone="muted">
        {label}
      </Text>
      {children}
    </div>
  );
}

function TypeKit(): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <Group label="App headings, Signal Red by default">
        <RoleList samples={HEADINGS} />
        <Heading level={3} variant="title-1" tone="ink">
          Welcome back
        </Heading>
      </Group>
      <Group label="Public site headings">
        <RoleList samples={SITE_HEADINGS} />
      </Group>
      <Group label="Reading, interface and figures">
        <RoleList samples={TEXT} />
      </Group>
      <Group label="Tones">
        <div className="flex flex-col gap-1">
          {TONES.map((tone) => (
            <Text key={tone} variant="ui" tone={tone}>
              {`The ${tone} tone`}
            </Text>
          ))}
        </div>
      </Group>
    </div>
  );
}

const section: KitSection = {
  title: 'Headings and type roles',
  part: 1,
  render: () => <TypeKit />,
};

export default section;
