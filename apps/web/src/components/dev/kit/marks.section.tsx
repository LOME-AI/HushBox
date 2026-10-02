import { CheckCircle2 } from '@hushbox/ui/icons';
import { Badge, Kbd, Swatch, ThemeToggle, type BadgeTone } from '@hushbox/ui/marks';
import type * as React from 'react';
import type { ModelSwatch } from '@hushbox/shared/design-tokens';
import type { KitSection } from './kit-sections';

const BADGES: readonly { tone: BadgeTone; label: string }[] = [
  { tone: 'success', label: 'Verified' },
  { tone: 'warning', label: 'Not set' },
  { tone: 'error', label: 'Failed' },
  { tone: 'info', label: 'In progress' },
  { tone: 'neutral', label: 'Draft' },
  { tone: 'brand', label: '2' },
];

const SWATCHES: readonly ModelSwatch[] = [1, 2, 3, 4, 5, 6, 7, 8];

const COMBOS = ['mod+k', 'mod+shift+o', 'escape'] as const;

function Sample({
  name,
  children,
}: Readonly<{ name: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-caption text-muted-foreground font-mono">{name}</p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function MarkSamples(): React.JSX.Element {
  return (
    <>
      <Sample name="badge">
        <Badge tone="success" icon={CheckCircle2}>
          Enabled
        </Badge>
        {BADGES.map((badge) => (
          <Badge key={badge.label} tone={badge.tone}>
            {badge.label}
          </Badge>
        ))}
      </Sample>
      <Sample name="swatch">
        {SWATCHES.map((swatch) => (
          <Swatch key={swatch} swatch={swatch} />
        ))}
      </Sample>
      <Sample name="swatch, large">
        {SWATCHES.map((swatch) => (
          <Swatch key={swatch} swatch={swatch} size="lg" />
        ))}
      </Sample>
      <Sample name="key hint, from 768 on a fine pointer">
        {COMBOS.map((combo) => (
          <Kbd key={combo} combo={combo} />
        ))}
      </Sample>
      <Sample name="theme toggle">
        <ThemeToggle />
      </Sample>
    </>
  );
}

const section: KitSection = {
  title: 'Badges and marks',
  part: 4,
  render: () => <MarkSamples />,
};

export default section;
