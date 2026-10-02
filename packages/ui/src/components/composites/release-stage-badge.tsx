import { RELEASE_STAGE, ROUTES, TERMS_BETA_SECTION } from '@hushbox/shared';
import { cn } from '../../lib/utilities';
import { HIT_AREA_CLASSES } from '../button/icon-button';
import { Badge } from '../marks/badge';
import type * as React from 'react';

/** What the badge hands the caller's link element: where it goes, its name, its look. */
interface ReleaseStageLinkProps {
  href: string;
  'aria-label': string;
  className: string;
  children: React.ReactNode;
}

interface ReleaseStageBadgeProps {
  stage?: typeof RELEASE_STAGE;
  /**
   * Draws the link around the badge, so each surface picks its own anchor (the native app
   * opens the Terms in its in-app browser). It is never called once the stage is stable,
   * which is what leaves no empty link behind.
   */
  link: (props: ReleaseStageLinkProps) => React.ReactNode;
}

const BETA_TERMS_HREF = `${ROUTES.TERMS}#${TERMS_BETA_SECTION.id}`;

/** The visible "Beta" leads the name, so a voice command that says what it sees still lands. */
const BETA_LINK_NAME = 'Beta: read what that means';

/** The release stage as a small tag beside the logo, linked to what the stage means. */
export function ReleaseStageBadge({
  stage = RELEASE_STAGE,
  link,
}: Readonly<ReleaseStageBadgeProps>): React.ReactNode {
  if (stage === 'stable') return null;
  return link({
    href: BETA_TERMS_HREF,
    'aria-label': BETA_LINK_NAME,
    className: cn(
      'inline-flex shrink-0 rounded-full transition-opacity hover:opacity-80',
      HIT_AREA_CLASSES.extend
    ),
    children: (
      <Badge tone="brand" size="compact">
        Beta
      </Badge>
    ),
  });
}
