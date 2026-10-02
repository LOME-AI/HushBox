import * as React from 'react';
import { Button, IconButton } from '@hushbox/ui/button';
import {
  AlertTriangle,
  CircleAlert,
  CircleCheck,
  Copy,
  Hourglass,
  Info,
  KeyRound,
  Lock,
  RefreshCw,
} from '@hushbox/ui/icons';
import { Notice, NoticeDismiss, NoticeStack } from '@hushbox/ui/notice';
import {
  Overlay,
  OverlayBody,
  OverlayContent,
  OverlayFooter,
  OverlayHeader,
  type OverlayProps,
} from '@hushbox/ui/overlay';
import type { KitSection } from './kit-sections';

function Sample({
  name,
  children,
}: Readonly<{ name: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-caption text-muted-foreground font-mono">{name}</p>
      {children}
    </div>
  );
}

function AddCredit(): React.JSX.Element {
  return <a href="#billing">Add credit</a>;
}

function ComposerStack(): React.JSX.Element {
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(new Set());
  const dismiss = (id: string) => (): void => {
    setDismissed((previous) => new Set(previous).add(id));
  };
  return (
    <NoticeStack>
      <Notice
        tone="error"
        icon={CircleAlert}
        placement="composer"
        title="Your balance can't cover this message."
      >
        <AddCredit />, or choose a more affordable model.
      </Notice>
      {!dismissed.has('low') && (
        <Notice
          tone="warning"
          icon={AlertTriangle}
          placement="composer"
          title="Your balance is running low, so replies may be shortened."
          end={<NoticeDismiss onDismiss={dismiss('low')} />}
        >
          <AddCredit /> for longer replies.
        </Notice>
      )}
      {!dismissed.has('free') && (
        <Notice
          tone="info"
          icon={Info}
          placement="composer"
          title="This message uses your free daily allowance."
          end={<NoticeDismiss onDismiss={dismiss('free')} />}
        >
          <AddCredit /> for more messages each day.
        </Notice>
      )}
      <Notice
        tone="error"
        icon={Hourglass}
        placement="composer"
        title="Another reply is still holding your funds."
      >
        Wait for it to finish, then send again.
      </Notice>
    </NoticeStack>
  );
}

function CopyButton(): React.JSX.Element {
  return <IconButton icon={Copy} size="xs" aria-label="Copy" />;
}

function Regenerate(): React.JSX.Element {
  return (
    <Button variant="outline">
      <RefreshCw />
      Regenerate
    </Button>
  );
}

interface DialogSampleProps {
  label: string;
  title: string;
  role?: OverlayProps['role'];
  confirm: string;
  children: React.ReactNode;
}

function DialogSample({
  label,
  title,
  role,
  confirm,
  children,
}: Readonly<DialogSampleProps>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const close = (): void => {
    setOpen(false);
  };
  return (
    <div>
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Overlay
        open={open}
        onOpenChange={setOpen}
        ariaLabel={title}
        {...(role !== undefined && { role })}
      >
        <OverlayContent size="sm">
          <OverlayHeader title={title} />
          <OverlayBody>{children}</OverlayBody>
          <OverlayFooter>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button onClick={close}>{confirm}</Button>
          </OverlayFooter>
        </OverlayContent>
      </Overlay>
    </div>
  );
}

function NoticeSamples(): React.JSX.Element {
  return (
    <>
      <Sample name="under the composer: a blocking notice has no dismiss">
        <ComposerStack />
      </Sample>
      <Sample name="a failed turn in the thread: Copy in the corner, Regenerate under the text">
        <Notice
          tone="error"
          icon={CircleAlert}
          placement="tile"
          title="This service is temporarily unavailable."
          end={<CopyButton />}
          actions={<Regenerate />}
        >
          Please try again later.
        </Notice>
      </Sample>
      <Sample name="a failed model's slot in a multi-model turn">
        <Notice
          tone="error"
          icon={CircleAlert}
          placement="slot"
          title="This model stopped before it finished answering."
          end={<CopyButton />}
          actions={<Regenerate />}
        >
          Try again, or choose a different model.
        </Notice>
      </Sample>
      <Sample name="inline: with no corner control the text takes the full width">
        <Notice tone="success" icon={CircleCheck}>
          Credit added.
        </Notice>
        <Notice tone="neutral" icon={Info}>
          Replies from this model can take a minute.
        </Notice>
      </Sample>
      <Sample name="destructive + subtle outside a dialog: the usage charts' error state">
        <Notice tone="error" icon={CircleAlert} destructive emphasis="subtle">
          Couldn&apos;t load this chart
        </Notice>
      </Sample>
      <Sample name="in a dialog: the Alert pairs">
        <div className="flex flex-wrap gap-4">
          <DialogSample
            label="Leave conversation"
            title="Leave Conversation?"
            role="alertdialog"
            confirm="Leave"
          >
            <Notice tone="warning" icon={AlertTriangle} emphasis="strong">
              As the owner, leaving will delete all messages and remove all members.
            </Notice>
          </DialogSample>
          <DialogSample
            label="Remove member"
            title="Remove Charlie?"
            role="alertdialog"
            confirm="Remove"
          >
            <Notice tone="warning" icon={AlertTriangle}>
              This member will lose access to the conversation.
            </Notice>
          </DialogSample>
          <DialogSample label="Add member" title="Add Member" confirm="Add Member">
            <Notice tone="error" icon={CircleAlert} destructive>
              This conversation has reached the maximum of 100 members.
            </Notice>
          </DialogSample>
          <DialogSample label="Share message" title="Share Message" confirm="Create Link">
            <Notice tone="neutral" icon={Lock} iconTone="success">
              Cryptographically isolated. This link gives access to this single message only,
              reasoning included.
            </Notice>
            <Notice tone="neutral" icon={KeyRound} iconTone="success">
              The key is the part of the link after the #, so HushBox&apos;s servers never receive
              it. Anyone with the link can read this reply.
            </Notice>
          </DialogSample>
        </div>
      </Sample>
    </>
  );
}

const section: KitSection = {
  title: 'Notices',
  part: 5,
  render: () => <NoticeSamples />,
};

export default section;
