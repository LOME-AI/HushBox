import * as React from 'react';
import { Button } from '@hushbox/ui/button';
import { TextField } from '@hushbox/ui/field';
import { Lock } from '@hushbox/ui/icons';
import {
  Overlay,
  OverlayBody,
  OverlayContent,
  OverlayFooter,
  OverlayHeader,
  type OverlayProps,
} from '@hushbox/ui/overlay';
import type { KitSection } from './kit-sections';

interface SampleProps {
  /** The button that opens the sample, and the note beside it. */
  label: string;
  note: string;
  overlay?: Pick<OverlayProps, 'role' | 'phonePresentation'>;
  children: (close: () => void) => React.ReactNode;
}

function Sample({ label, note, overlay, children }: Readonly<SampleProps>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const close = (): void => {
    setOpen(false);
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-caption text-muted-foreground font-mono">{note}</p>
      <div>
        <Button
          variant="outline"
          onClick={() => {
            setOpen(true);
          }}
        >
          {label}
        </Button>
      </div>
      <Overlay open={open} onOpenChange={setOpen} ariaLabel={label} {...overlay}>
        {children(close)}
      </Overlay>
    </div>
  );
}

function CancelConfirm({
  close,
  confirm,
  variant = 'default',
}: Readonly<{
  close: () => void;
  confirm: string;
  variant?: 'default' | 'destructive';
}>): React.JSX.Element {
  return (
    <OverlayFooter>
      <Button variant="outline" onClick={close}>
        Cancel
      </Button>
      <Button variant={variant} onClick={close}>
        {confirm}
      </Button>
    </OverlayFooter>
  );
}

function OverlaySamples(): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-6">
      <Sample label="Change password" note="a sheet below 768, a dialog from 768">
        {(close) => (
          <OverlayContent>
            <OverlayHeader
              title="Change Password"
              description="Other devices will be signed out."
            />
            <OverlayBody>
              <TextField
                label="Current password"
                icon={Lock}
                type="password"
                autoComplete="current-password"
              />
              <TextField
                label="New password"
                icon={Lock}
                type="password"
                autoComplete="new-password"
              />
            </OverlayBody>
            <CancelConfirm close={close} confirm="Change password" />
          </OverlayContent>
        )}
      </Sample>
      <Sample label="Stepped dialog" note="the step above the title">
        {(close) => (
          <OverlayContent>
            <OverlayHeader
              title="Save your recovery phrase"
              step={{ current: 1, total: 3 }}
              description="Write these words down and keep them somewhere safe."
            />
            <CancelConfirm close={close} confirm="Continue" />
          </OverlayContent>
        )}
      </Sample>
      <Sample label="Centred head" note="size lg, centred, media and meta">
        {(close) => (
          <OverlayContent>
            <OverlayHeader
              title="Sign up to continue"
              size="lg"
              align="center"
              media={<Lock aria-hidden className="text-muted-foreground size-10" />}
              meta={<span className="text-foreground text-sm font-semibold">A premium model</span>}
              description="Create a free account to use this model."
            />
            <CancelConfirm close={close} confirm="Sign up" />
          </OverlayContent>
        )}
      </Sample>
      <Sample
        label="Top placement"
        note="12vh down from 768, full screen below"
        overlay={{ phonePresentation: 'fullscreen' }}
      >
        {() => (
          <OverlayContent placement="top" size="xl">
            <OverlayHeader title="Jump to" />
            <TextField label="Search" />
          </OverlayContent>
        )}
      </Sample>
      <Sample
        label="Alert dialog"
        note="role alertdialog at 24rem"
        overlay={{ role: 'alertdialog' }}
      >
        {(close) => (
          <OverlayContent size="sm">
            <OverlayHeader
              title="Delete conversation?"
              description="This conversation and its messages are deleted for good."
            />
            <CancelConfirm close={close} confirm="Delete" variant="destructive" />
          </OverlayContent>
        )}
      </Sample>
    </div>
  );
}

const section: KitSection = {
  title: 'Overlays',
  part: 6,
  render: () => <OverlaySamples />,
};

export default section;
