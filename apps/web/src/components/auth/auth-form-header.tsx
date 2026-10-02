import { Heading } from '@hushbox/ui/type';
import type * as React from 'react';

type SubtitleTone = 'tagline' | 'instruction' | 'muted' | 'text';

interface AuthFormHeaderProps {
  title: string;
  subtitle: React.ReactNode;
  titleTone?: 'ink' | 'signal';
  subtitleTone?: SubtitleTone;
}

const SUBTITLE_CLASS: Readonly<Record<SubtitleTone, string>> = {
  tagline: 'text-primary text-lg font-medium',
  instruction: 'text-primary text-lg font-medium',
  muted: 'text-muted-foreground text-sm',
  text: 'text-muted-foreground text-base',
};

/**
 * The title and subtitle every auth step opens with. Only the brand tagline is a
 * reading surface; an instruction in the same look stays on the sans chrome face.
 * The word break sits on the column because `Heading` takes no class and the break inherits.
 */
export function AuthFormHeader({
  title,
  subtitle,
  titleTone = 'ink',
  subtitleTone = 'tagline',
}: Readonly<AuthFormHeaderProps>): React.JSX.Element {
  return (
    <div className="mb-5 flex min-w-0 flex-col gap-2 text-center wrap-break-word">
      <Heading level={1} variant="auth-title" tone={titleTone}>
        {title}
      </Heading>
      <p
        className={SUBTITLE_CLASS[subtitleTone]}
        data-reading={subtitleTone === 'tagline' ? '' : undefined}
      >
        {subtitle}
      </p>
    </div>
  );
}
