import * as React from 'react';
import { Kbd } from '@hushbox/ui';
import { InlineInput, TextField } from '@hushbox/ui/field';
import { DollarSign, Eye, EyeOff, Lock, Mail, Search } from '@hushbox/ui/icons';
import type { KitSection } from './kit-sections';

function Cell({
  caption,
  children,
}: Readonly<{ caption: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-caption text-muted-foreground font-mono">{caption}</p>
      {children}
    </div>
  );
}

function PasswordSample(): React.JSX.Element {
  const [shown, setShown] = React.useState(false);
  const Glyph = shown ? EyeOff : Eye;
  return (
    <TextField
      label="Password"
      icon={Lock}
      type={shown ? 'text' : 'password'}
      autoComplete="current-password"
      defaultValue="hunter2hunter2"
      suffix={
        <button
          type="button"
          onClick={() => {
            setShown((previous) => !previous);
          }}
          className="hover:text-foreground rounded-sm p-1 transition-colors"
          aria-label={shown ? 'Hide password' : 'Show password'}
        >
          <Glyph aria-hidden className="size-5" />
        </button>
      }
    />
  );
}

function TextFieldSamples(): React.JSX.Element {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(15rem,100%),1fr))] items-start gap-x-5 gap-y-4">
      <Cell caption="empty">
        <TextField label="Username" />
      </Cell>
      <Cell caption="focus (tab to it)">
        <TextField label="Username" />
      </Cell>
      <Cell caption="filled">
        <TextField label="Username" defaultValue="alice" />
      </Cell>
      <Cell caption="icon">
        <TextField label="Email or Username" icon={Mail} autoComplete="username" />
      </Cell>
      <Cell caption="icon, filled, password">
        <PasswordSample />
      </Cell>
      <Cell caption="error">
        <TextField
          label="Email"
          icon={Mail}
          defaultValue="alice@example"
          error="Enter a valid email address"
        />
      </Cell>
      <Cell caption="success">
        <TextField label="Username" defaultValue="alice" success="Username is available" />
      </Cell>
      <Cell caption="disabled">
        <TextField label="Amount (USD)" icon={DollarSign} defaultValue="25.00" disabled />
      </Cell>
      <Cell caption="sidebar search">
        <TextField label="Search chats" icon={Search} suffix={<Kbd combo="mod+k" />} />
      </Cell>
      <Cell caption="no visible label">
        <TextField aria-label="Search models" placeholder="Search models" />
      </Cell>
      <Cell caption="message box">
        <TextField
          multiline
          label="What you type"
          defaultValue="This is private."
          spellCheck={false}
          className="h-52 resize-none md:h-37"
        />
      </Cell>
      <Cell caption="inline input">
        <InlineInput aria-label="Search members" placeholder="Search members" />
      </Cell>
    </div>
  );
}

const section: KitSection = {
  title: 'Floating-label fields',
  part: 3,
  render: () => <TextFieldSamples />,
};

export default section;
