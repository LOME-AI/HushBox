import * as React from 'react';
import { Button, IconButton } from '@hushbox/ui/button';
import { ChevronRight, Copy, MoreVertical, RefreshCw, X } from '@hushbox/ui/icons';
import type { KitSection } from './kit-sections';

function Cell({
  caption,
  children,
}: Readonly<{ caption: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <p className="text-caption text-muted-foreground font-mono">{caption}</p>
      {children}
    </div>
  );
}

function Row({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="flex flex-wrap items-end gap-x-5 gap-y-4">{children}</div>;
}

function LoadingSample(): React.JSX.Element {
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        loading={busy}
        loadingLabel="Saving changes"
        onClick={() => {
          setBusy(true);
        }}
      >
        Save changes
      </Button>
      <Button
        variant="link"
        onClick={() => {
          setBusy(false);
        }}
      >
        Reset
      </Button>
    </div>
  );
}

function ButtonSamples(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <Row>
        <Cell caption="primary">
          <Button>Save</Button>
        </Cell>
        <Cell caption="hover and focus (point, tab)">
          <Button>Save</Button>
        </Cell>
        <Cell caption="loading">
          <Button loading loadingLabel="Saving">
            Save
          </Button>
        </Cell>
        <Cell caption="disabled">
          <Button disabled>Save</Button>
        </Cell>
      </Row>
      <Row>
        <Cell caption="secondary">
          <Button variant="secondary">Cancel</Button>
        </Cell>
        <Cell caption="outline">
          <Button variant="outline">Export</Button>
        </Cell>
        <Cell caption="ghost">
          <Button variant="ghost">Skip</Button>
        </Cell>
        <Cell caption="link">
          <Button variant="link">Forgot password?</Button>
        </Cell>
        <Cell caption="destructive">
          <Button variant="destructive">Delete</Button>
        </Cell>
        <Cell caption="icon">
          <IconButton aria-label="Copy" icon={Copy} />
        </Cell>
      </Row>
      <Cell caption="disabled: neutral in every variant">
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled>Save</Button>
          <Button variant="secondary" disabled>
            Cancel
          </Button>
          <Button variant="outline" disabled>
            Export
          </Button>
          <Button variant="destructive" disabled>
            Delete
          </Button>
          <Button variant="ghost" disabled>
            Skip
          </Button>
          <Button variant="link" disabled>
            Forgot password?
          </Button>
          <IconButton aria-label="Copy" icon={Copy} disabled />
        </div>
      </Cell>
      <Row>
        <Cell caption="aria-disabled: focusable, refuses clicks">
          <Button aria-disabled="true">Regenerate</Button>
        </Cell>
        <Cell caption="loading, width held">
          <LoadingSample />
        </Cell>
      </Row>
      <Row>
        <Cell caption="sm">
          <Button size="sm">Open HushBox</Button>
        </Cell>
        <Cell caption="md">
          <Button>Add credit</Button>
        </Cell>
        <Cell caption="lg">
          <Button size="lg">Add credit</Button>
        </Cell>
        <Cell caption="xl">
          <Button size="xl">Log in</Button>
        </Cell>
        <Cell caption="with an icon">
          <Button variant="outline">
            <RefreshCw />
            Regenerate
          </Button>
        </Cell>
      </Row>
      <Row>
        <Cell caption="icon 2xs">
          <IconButton aria-label="More options" icon={MoreVertical} size="2xs" hitArea="extend" />
        </Cell>
        <Cell caption="icon xs">
          <IconButton aria-label="Dismiss" icon={X} size="xs" />
        </Cell>
        <Cell caption="icon sm">
          <IconButton aria-label="Copy message" icon={Copy} size="sm" />
        </Cell>
        <Cell caption="icon md">
          <IconButton aria-label="Copy code" icon={Copy} />
        </Cell>
        <Cell caption="icon lg">
          <IconButton aria-label="Close" icon={X} size="lg" />
        </Cell>
      </Row>
      <Cell caption="bare: a row that lays itself out">
        <Button
          variant="bare"
          className="border-border hover:bg-accent flex w-full max-w-sm items-center justify-between gap-3 rounded-md border px-3 py-2 text-left"
        >
          <span className="text-ui">Notifications</span>
          <ChevronRight aria-hidden className="text-muted-foreground size-4" />
        </Button>
      </Cell>
    </div>
  );
}

const section: KitSection = {
  title: 'Buttons',
  part: 2,
  render: () => <ButtonSamples />,
};

export default section;
