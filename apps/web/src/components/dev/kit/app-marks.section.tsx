import { Brain, Globe, Lock, Plus } from '@hushbox/ui/icons';
import { Avatar } from '@/components/shared/avatar';
import { Chip } from '@/components/shared/chip';
import { ModelChip } from '@/components/shared/model-chip';
import { Facepile } from '@/components/shared/facepile';
import { TrustLine } from '@/components/shared/trust-line';
import type * as React from 'react';
import type { KitSection } from './kit-sections';

const noop = (): undefined => undefined;

const TRUST_COPY = 'Saved encrypted with a key only your devices hold.';

const THREE = [
  { name: 'Alice', online: true },
  { name: 'Bob', online: false },
  { name: 'Carol', online: false },
] as const;

const FIVE = [...THREE, { name: 'Dave', online: true }, { name: 'Erin', online: false }] as const;

/** One captioned sample; `data-sample` names it for the geometry test. */
function Figure({
  name,
  caption,
  className,
  children,
}: Readonly<{
  name: string;
  caption: string;
  className?: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="text-caption text-muted-foreground font-mono">{caption}</figcaption>
      <div data-sample={name} className={className ?? 'flex flex-wrap items-center gap-2'}>
        {children}
      </div>
    </figure>
  );
}

function AppMarkSamples(): React.JSX.Element {
  return (
    <>
      <div className="flex flex-wrap items-end gap-4">
        <Figure name="chip-icon" caption="icon only">
          <Chip icon={Plus} iconOnly label="Change mode" aria-haspopup="menu" />
        </Figure>
        <Figure name="chip-unpressed" caption="unpressed">
          <Chip icon={Globe} label="Search" pressed={false} />
        </Figure>
        <Figure name="chip-pressed" caption="pressed">
          <Chip icon={Globe} label="Search" pressed />
        </Figure>
        <Figure name="chip-disabled" caption="disabled">
          <Chip icon={Globe} label="Search" disabled />
        </Figure>
        <Figure name="chip-expanded" caption="menu open">
          <Chip icon={Brain} label="Mid" aria-haspopup="menu" expanded />
        </Figure>
        <Figure name="chip-model" caption="model, picker open">
          <ModelChip swatch={2} label="GPT-5" expanded onClick={noop} />
        </Figure>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <Figure name="model-truncate" caption="model, long name">
          <ModelChip
            swatch={1}
            label="Claude Sonnet 4.5 Thinking Extended"
            expanded={false}
            onClick={noop}
          />
        </Figure>
        <Figure
          name="model-compact"
          caption="model, compact composer"
          className="@container/composer flex w-72 items-center"
        >
          <ModelChip
            swatch={3}
            label="Gemini 2.5 Flash"
            shortLabel="Flash"
            expanded={false}
            onClick={noop}
          />
        </Figure>
      </div>
      <div className="flex flex-wrap items-end gap-6">
        <Figure name="avatars" caption="avatar: online, offline, person">
          <Avatar name="Alice" online />
          <Avatar name="Bob" />
          <Avatar person />
        </Figure>
        <Figure name="facepile" caption="facepile">
          <Facepile members={THREE} onOpen={noop} />
          <Facepile members={FIVE} onOpen={noop} />
        </Figure>
      </div>
      <Figure name="trust-start" caption="trust line" className="max-w-md">
        <TrustLine icon={Lock}>{TRUST_COPY}</TrustLine>
      </Figure>
      <Figure name="trust-center" caption="trust line, centred" className="max-w-md">
        <TrustLine icon={Lock} align="center">
          {TRUST_COPY}
        </TrustLine>
      </Figure>
      <Figure name="trust-ui-sm" caption="trust line, small ui size, centred" className="max-w-md">
        <TrustLine icon={Lock} size="ui-sm" align="center">
          {TRUST_COPY}
        </TrustLine>
      </Figure>
      <Figure name="trust-wrapped" caption="trust line, wrapped" className="w-40">
        <TrustLine icon={Lock}>{TRUST_COPY}</TrustLine>
      </Figure>
    </>
  );
}

const section: KitSection = {
  title: 'Chips, avatars and trust lines',
  part: 4,
  render: () => <AppMarkSamples />,
};

export default section;
