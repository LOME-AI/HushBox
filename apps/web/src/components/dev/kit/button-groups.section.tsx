import { Button, ButtonRow, ButtonStack, IconButton } from '@hushbox/ui/button';
import { ArrowLeft, ArrowUpRight, Icon, MoreVertical } from '@hushbox/ui/icons';
import type * as React from 'react';
import type { KitSection } from './kit-sections';

type Space = '17rem' | '18rem' | '20rem' | '27rem' | '35rem' | '50rem';

const SPACE_WIDTH: Record<Space, string> = {
  '17rem': 'w-[17rem]',
  '18rem': 'w-[18rem]',
  '20rem': 'w-[20rem]',
  '27rem': 'w-[27rem]',
  '35rem': 'w-[35rem]',
  '50rem': 'w-[50rem]',
};

/**
 * One group drawn in a space of a fixed width, outlined so the space shows. The outline
 * sits outside the space and takes none of it; a space wider than the island scrolls.
 */
function Sample({
  caption,
  width,
  children,
}: Readonly<{ caption: string; width: Space; children: React.ReactNode }>): React.JSX.Element {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="text-caption text-muted-foreground font-mono">{caption}</figcaption>
      <div className="overflow-x-auto p-1">
        <div
          data-space={width}
          className={`${SPACE_WIDTH[width]} outline-border shrink-0 outline-1 outline-offset-2 outline-dashed`}
        >
          {children}
        </div>
      </div>
    </figure>
  );
}

function CancelOrChange(): React.JSX.Element {
  return (
    <ButtonRow>
      <Button variant="outline">Cancel</Button>
      <Button>Change password</Button>
    </ButtonRow>
  );
}

function PaymentSimulation(): React.JSX.Element {
  return (
    <ButtonRow>
      <Button variant="outline">Simulate failure</Button>
      <Button variant="outline">Simulate success</Button>
      <Button>Pay $25.00</Button>
    </ButtonRow>
  );
}

function RecoveryPhrase(): React.JSX.Element {
  return (
    <ButtonStack>
      <Button variant="outline">Copy</Button>
      <Button variant="outline">Download .txt</Button>
      <Button>I&apos;ve written it down</Button>
    </ButtonStack>
  );
}

function ButtonGroupSamples(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <p className="text-ui text-muted-foreground max-w-prose text-pretty">
        A button&apos;s space decides its width. Up to 40rem, buttons fill the space and share a row
        equally; a row too narrow for them stacks in markup order. Wider, each keeps its own width,
        at least 12rem, centred, and a group takes its widest label&apos;s width. A block button
        follows the same rule on its own and its group&apos;s rule inside one.
      </p>
      <Sample caption="two buttons in 17rem" width="17rem">
        <CancelOrChange />
      </Sample>
      <Sample caption="two buttons in 35rem" width="35rem">
        <CancelOrChange />
      </Sample>
      <Sample caption="two buttons in 50rem" width="50rem">
        <ButtonRow>
          <Button variant="outline">Not now</Button>
          <Button>Continue with a passkey on this device</Button>
        </ButtonRow>
      </Sample>
      <Sample caption="three buttons in 27rem" width="27rem">
        <PaymentSimulation />
      </Sample>
      <Sample caption="three buttons in 35rem" width="35rem">
        <PaymentSimulation />
      </Sample>
      <Sample caption="a stack in 35rem" width="35rem">
        <RecoveryPhrase />
      </Sample>
      <Sample caption="a stack in 50rem" width="50rem">
        <RecoveryPhrase />
      </Sample>
      <Sample caption="short labels in 18rem" width="18rem">
        <ButtonRow stack="labels">
          <Button variant="outline">Cancel</Button>
          <Button>Save</Button>
        </ButtonRow>
      </Sample>
      <Sample caption="the billing pair in 18rem" width="18rem">
        <ButtonRow stack="labels" stackedOrder="reverse">
          <Button variant="outline">Add Credits</Button>
          <Button>
            Return to the app
            <ArrowUpRight aria-hidden />
          </Button>
        </ButtonRow>
      </Sample>
      <Sample caption="a lone block button in 35rem" width="35rem">
        <Button block>Log in</Button>
      </Sample>
      <Sample caption="a lone block button in 50rem" width="50rem">
        <Button block>Try HushBox Free</Button>
      </Sample>
      <Sample caption="a lone block button with a long label in 50rem" width="50rem">
        <Button block>Continue with a passkey on this device</Button>
      </Sample>
      <Sample caption="a block button in a row in 17rem" width="17rem">
        <ButtonRow>
          <Button variant="outline" block>
            Not now
          </Button>
          <Button>Continue with a passkey</Button>
        </ButtonRow>
      </Sample>
      <Sample caption="a block button in a row in 50rem" width="50rem">
        <ButtonRow>
          <Button variant="outline" block>
            Not now
          </Button>
          <Button>Continue with a passkey on this device</Button>
        </ButtonRow>
      </Sample>
      <Sample caption="a block button in a stack in 50rem" width="50rem">
        <ButtonStack>
          <Button variant="outline" block>
            Copy
          </Button>
          <Button>Continue with a passkey on this device</Button>
        </ButtonStack>
      </Sample>
      <Sample caption="an icon-leading pair in 20rem" width="20rem">
        <ButtonRow>
          <Button variant="outline">
            <Icon icon={ArrowLeft} />
            Back
          </Button>
          <Button>Continue</Button>
        </ButtonRow>
      </Sample>
      <Sample caption="a large icon-leading pair by labels in 20rem" width="20rem">
        <ButtonRow stack="labels">
          <Button size="lg" variant="outline">
            <Icon icon={ArrowLeft} />
            Back
          </Button>
          <Button size="lg">Continue</Button>
        </ButtonRow>
      </Sample>
      <Sample caption="an icon button in a row" width="20rem">
        <ButtonRow>
          <Button variant="outline">Regenerate</Button>
          <IconButton aria-label="More options" icon={MoreVertical} />
        </ButtonRow>
      </Sample>
    </div>
  );
}

const section: KitSection = {
  title: 'Button groups',
  part: 2,
  render: () => <ButtonGroupSamples />,
};

export default section;
