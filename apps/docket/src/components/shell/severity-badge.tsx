import { Badge } from '@hushbox/ui/marks';
import type { Severity } from '@hushbox/docket';
import type { BadgeTone } from '@hushbox/ui/marks';
import type { JSX } from 'react';

// Danger red is spent on the two severities that mean danger; the rest stay
// neutral, and the word itself carries the reading either way.
const TONES: Record<Severity, BadgeTone> = {
  critical: 'error',
  high: 'error',
  medium: 'secondary',
  low: 'neutral',
};

export function SeverityBadge({ severity }: Readonly<{ severity: Severity }>): JSX.Element {
  return <Badge tone={TONES[severity]}>{severity}</Badge>;
}
