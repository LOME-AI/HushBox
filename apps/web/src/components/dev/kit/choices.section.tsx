import * as React from 'react';
import {
  CheckField,
  RadioGroupField,
  SelectField,
  SwitchField,
  TextareaField,
  ToggleGroup,
  ToggleGroupItem,
} from '@hushbox/ui/field';
import type { KitSection } from './kit-sections';

const INSTRUCTIONS =
  "I'm a backend engineer who works mostly in TypeScript and Postgres. Be concise, lead with the answer, and show code before explaining it. Use metric units. When you're unsure, say so instead of guessing.";

const OVER_LIMIT = 'The copy button on code blocks does nothing in Safari.';

type Period = 'monthly' | 'lifetime';
type Font = 'merriweather' | 'atkinson' | 'lexend';
type Kind = 'bug' | 'idea' | 'praise';

const KINDS: readonly { value: Kind; label: string }[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' },
  { value: 'praise', label: 'Praise' },
];

function Cell({
  caption,
  children,
}: Readonly<{ caption: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-caption text-muted-foreground font-mono">{caption}</p>
      {children}
    </div>
  );
}

function Check({
  label,
  description,
  size,
  disabled,
  initial = false,
}: Readonly<{
  label: string;
  description?: string;
  size?: 'lg';
  disabled?: boolean;
  initial?: boolean;
}>): React.JSX.Element {
  const [checked, setChecked] = React.useState(initial);
  return (
    <CheckField
      checked={checked}
      onCheckedChange={setChecked}
      label={label}
      {...(description !== undefined && { description })}
      {...(size !== undefined && { size })}
      {...(disabled !== undefined && { disabled })}
    />
  );
}

function Toggle({
  label,
  description,
  disabled,
  initial = false,
}: Readonly<{
  label: string;
  description?: string;
  disabled?: boolean;
  initial?: boolean;
}>): React.JSX.Element {
  const [checked, setChecked] = React.useState(initial);
  return (
    <SwitchField
      checked={checked}
      onCheckedChange={setChecked}
      label={label}
      {...(description !== undefined && { description })}
      {...(disabled !== undefined && { disabled })}
    />
  );
}

function Checks(): React.JSX.Element {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(13rem,100%),1fr))] items-start gap-x-5 gap-y-4">
      <Cell caption="one line">
        <div data-centring="1" className="max-w-44">
          <Check label="Remember this device" initial />
        </div>
      </Cell>
      <Cell caption="two lines">
        <div data-centring="2" className="max-w-44">
          <Check label="Email me when my balance runs low" />
        </div>
      </Cell>
      <Cell caption="three lines">
        <div data-centring="3" className="max-w-44">
          <Check
            label="Forfeit my balance"
            description="Any credit left in your account is lost."
          />
        </div>
      </Cell>
      <Cell caption="large (24px)">
        <Check label="Keep me signed in" size="lg" />
      </Cell>
      <Cell caption="disabled">
        <Check label="Remember this device" disabled />
      </Cell>
    </div>
  );
}

function Switches(): React.JSX.Element {
  return (
    <div className="divide-border border-border flex flex-col divide-y border-y">
      <div data-centring="switch" className="py-2.5">
        <Toggle
          label="Email notifications"
          description="A message when a long reply finishes or a member joins."
          initial
        />
      </div>
      <div className="py-2.5">
        <Toggle label="Push notifications" />
      </div>
      <div className="py-2.5">
        <Toggle label="Quiet hours" description="Hold notifications overnight." disabled />
      </div>
    </div>
  );
}

function LongForm(): React.JSX.Element {
  const [instructions, setInstructions] = React.useState(INSTRUCTIONS);
  const [feedback, setFeedback] = React.useState(OVER_LIMIT);
  const [period, setPeriod] = React.useState<Period>('monthly');
  const [font, setFont] = React.useState<Font>('merriweather');
  const [kind, setKind] = React.useState<Kind>('bug');
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] items-start gap-x-5 gap-y-6">
      <Cell caption="counted textarea">
        <TextareaField
          label="What should every model know?"
          help="For example, your work, your tone, units, or languages."
          rows={5}
          value={instructions}
          onChange={(event) => {
            setInstructions(event.target.value);
          }}
          count={{ value: instructions.length, max: 5000 }}
        />
      </Cell>
      <Cell caption="over the limit">
        <TextareaField
          label="Feedback"
          rows={3}
          value={feedback}
          onChange={(event) => {
            setFeedback(event.target.value);
          }}
          count={{ value: feedback.length, max: 40 }}
        />
      </Cell>
      <Cell caption="error, optional">
        <TextareaField label="Notes" optional rows={3} error="Notes can't be longer than a page." />
      </Cell>
      <Cell caption="select">
        <SelectField<Font>
          label="Font"
          help="Applies to reading surfaces."
          value={font}
          onValueChange={setFont}
          options={[
            { value: 'merriweather', label: 'Merriweather (default)' },
            { value: 'atkinson', label: 'Atkinson Hyperlegible (low vision)' },
            { value: 'lexend', label: 'Lexend (reading speed)' },
          ]}
        />
      </Cell>
      <Cell caption="select, error">
        <SelectField<Period>
          label="Reset"
          error="Choose when the budget resets."
          value={period}
          onValueChange={setPeriod}
          options={[
            { value: 'monthly', label: 'Monthly' },
            { value: 'lifetime', label: 'Lifetime' },
          ]}
        />
      </Cell>
      <Cell caption="radio group">
        <RadioGroupField<Period>
          legend="Budget period"
          value={period}
          onValueChange={setPeriod}
          options={[
            {
              value: 'monthly',
              label: 'Monthly',
              description: 'Resets on the first of the month.',
            },
            { value: 'lifetime', label: 'Lifetime' },
          ]}
        />
      </Cell>
      <Cell caption="toggle group">
        <ToggleGroup
          type="single"
          variant="outline"
          className="w-full"
          aria-label="Feedback type"
          value={kind}
          onValueChange={(next) => {
            for (const option of KINDS) if (option.value === next) setKind(option.value);
          }}
        >
          {KINDS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Cell>
    </div>
  );
}

const section: KitSection = {
  title: 'Choices',
  part: 3,
  render: () => (
    <div className="flex flex-col gap-8">
      <Checks />
      <Switches />
      <LongForm />
    </div>
  ),
};

export default section;
