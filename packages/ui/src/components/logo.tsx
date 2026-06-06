import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { cn } from '../lib/utilities';
import logoUrl from '../assets/HushBoxLogo.png';

interface LogoProps {
  className?: string;
}

/** Resolves a bundler image import to a URL string. Handles Vite (string) and Astro SSR ({ src }). */
function resolveImageSource(imported: unknown): string {
  if (typeof imported === 'string') return imported;
  if (typeof imported === 'object' && imported !== null && 'src' in imported) {
    return (imported as { src: string }).src;
  }
  console.warn(`Unexpected logo import type: ${typeof imported}`);
  return '';
}

function Logo({ className }: Readonly<LogoProps>): React.JSX.Element {
  const imageSource = resolveImageSource(logoUrl);

  return (
    <div
      data-testid={TEST_IDS.logo}
      data-no-invert=""
      className={cn('flex items-center gap-2', className)}
    >
      {/* eslint-disable-next-line no-restricted-syntax -- Logo IS the brand image primitive; must render the raw <img> for the official mark */}
      <img src={imageSource} alt="HushBox Logo" className="h-6 w-6 shrink-0 object-contain" />
      <span className="text-lg leading-none font-bold">
        Hush<span className="text-brand-red">Box</span>
      </span>
    </div>
  );
}

export { Logo, resolveImageSource as resolveImageSrc, type LogoProps };
