import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { Button, IconButton } from '@hushbox/ui/button';
import {
  Accessibility,
  BarChart3,
  CreditCard,
  Database,
  ExternalLink,
  Image,
  Info,
  LogOut,
  MoreVertical,
  Pencil,
  Settings,
  Trash2,
  Type,
  Video,
} from '@hushbox/ui/icons';
import {
  Menu,
  MenuFooter,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from '@hushbox/ui/menu';
import type { KitSection } from './kit-sections';

type Effort = 'auto' | 'max' | 'high' | 'mid' | 'low' | 'lite' | 'min';
type Mode = 'text' | 'image' | 'video';

const EFFORT_WORDS: Record<Effort, string> = {
  auto: 'Auto',
  max: 'Max',
  high: 'High',
  mid: 'Mid',
  low: 'Low',
  lite: 'Lite',
  min: 'Min',
};

function doNothing(): void {
  // A sample item's choice has nowhere to go.
}

function Sample({
  note,
  children,
}: Readonly<{ note: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <p className="text-caption text-muted-foreground font-mono">{note}</p>
      {children}
    </div>
  );
}

function EffortSample(): React.JSX.Element {
  const [effort, setEffort] = React.useState<Effort>('mid');
  return (
    <Menu
      trigger={<Button variant="outline">{`Effort · ${EFFORT_WORDS[effort]}`}</Button>}
      title="Reasoning effort"
      align="start"
      side="top"
      sheetHeader="none"
    >
      <MenuRadioGroup<Effort> value={effort} onValueChange={setEffort}>
        <MenuRadioItem<Effort>
          value="auto"
          title="Auto"
          description="The model decides for each message"
        />
        <MenuRadioItem<Effort>
          value="max"
          title="Max"
          disabled
          disabledReason="This model can't write a long enough answer."
        />
        <MenuRadioItem<Effort> value="high" title="High" description="Careful multi-step work" />
        <MenuRadioItem<Effort> value="mid" title="Mid" description="Most everyday questions" />
        <MenuRadioItem<Effort>
          value="low"
          title="Low"
          description="Quick checks and short answers"
        />
        <MenuRadioItem<Effort>
          value="lite"
          title="Lite"
          description="A brief look before answering"
        />
        <MenuRadioItem<Effort> value="min" title="Min" description="Answers without reasoning" />
      </MenuRadioGroup>
    </Menu>
  );
}

function ModeSample(): React.JSX.Element {
  const [mode, setMode] = React.useState<Mode>('text');
  return (
    <Menu
      trigger={<Button variant="outline">Change mode</Button>}
      title="Change mode"
      align="start"
      side="top"
      minWidth="12rem"
    >
      <MenuRadioGroup<Mode> value={mode} onValueChange={setMode}>
        <MenuRadioItem<Mode> value="text" icon={Type} title="Text" />
        <MenuRadioItem<Mode> value="image" icon={Image} title="Image" />
        <MenuRadioItem<Mode> value="video" icon={Video} title="Video" />
      </MenuRadioGroup>
    </Menu>
  );
}

function LockedModeSample(): React.JSX.Element {
  const [mode, setMode] = React.useState<Mode>('text');
  return (
    <Menu
      trigger={<Button variant="outline">Change mode, image locked</Button>}
      title="Change mode"
      align="start"
      side="top"
      minWidth="12rem"
    >
      <MenuRadioGroup<Mode> value={mode} onValueChange={setMode}>
        <MenuRadioItem<Mode> value="text" icon={Type} title="Text" />
        <MenuRadioItem<Mode>
          value="image"
          icon={Image}
          title="Image"
          disabled
          disabledReason="Add credit to unlock image generation"
        />
        <MenuRadioItem<Mode> value="video" icon={Video} title="Video" />
      </MenuRadioGroup>
      <MenuFooter>Applies to your next message.</MenuFooter>
    </Menu>
  );
}

function MenuSamples(): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-6">
      <Sample note="a sheet below 768, anchored from 768">
        <Menu
          trigger={<IconButton icon={MoreVertical} aria-label="More options" />}
          title="More options"
        >
          <MenuItem icon={Accessibility} title="Accessibility" onSelect={doNothing} />
        </Menu>
      </Sample>
      <Sample note="anchored at every width">
        <Menu
          trigger={<Button variant="outline">Account</Button>}
          title="Account"
          align="start"
          phonePresentation="anchored"
        >
          <MenuLabel>alice@hushbox.ai</MenuLabel>
          <MenuItem icon={Settings} title="Settings" end="Ctrl ," onSelect={doNothing} />
          <MenuItem icon={BarChart3} title="Usage" onSelect={doNothing} />
          <MenuItem icon={CreditCard} title="Add Credits" onSelect={doNothing} />
          <MenuSeparator />
          <MenuItem icon={LogOut} title="Log Out" onSelect={doNothing} />
        </Menu>
      </Sample>
      <Sample note="link items: this tab, a new tab, and disabled">
        <Menu trigger={<Button variant="outline">Links</Button>} title="Links" align="start">
          <MenuItem icon={Info} title="About HushBox" href="/welcome" />
          <MenuItem
            icon={ExternalLink}
            title="GitHub"
            href="https://github.com/lome-ai/hushbox"
            external
            data-testid={TEST_IDS.menuGithub}
          />
          <MenuItem
            icon={Database}
            title="Database Studio"
            href="https://local.drizzle.studio"
            external
            disabled
            disabledReason="Opens only while developing locally"
          />
        </Menu>
      </Sample>
      <Sample note="a danger item">
        <Menu
          trigger={<IconButton icon={MoreVertical} aria-label="Conversation actions" />}
          title="Conversation"
          align="start"
        >
          <MenuItem icon={Pencil} title="Rename" onSelect={doNothing} />
          <MenuItem icon={Trash2} title="Delete" tone="danger" onSelect={doNothing} />
        </Menu>
      </Sample>
      <Sample note="two-line radio items, no sheet head">
        <EffortSample />
      </Sample>
      <Sample note="12rem floor, check at the end">
        <ModeSample />
      </Sample>
      <Sample note="a disabled row with its reason, and a footer">
        <LockedModeSample />
      </Sample>
    </div>
  );
}

const section: KitSection = {
  title: 'Menus',
  part: 6,
  render: () => <MenuSamples />,
};

export default section;
