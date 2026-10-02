import * as React from 'react';

/**
 * The first focusable element of an app shell, letting keyboard and screen-reader users jump
 * past the navigation (WCAG 2.4.1). It targets the shell's `<main id="main" tabIndex={-1}>`,
 * which is what makes the fragment move focus. Visually hidden until focused.
 *
 * `outline-hidden`, not `outline-none`: forced colors drop the box-shadow ring, and
 * `outline-hidden` keeps a transparent outline there that the system repaints visibly.
 */
export function SkipLink(): React.JSX.Element {
  return (
    <a
      href="#main"
      className="bg-background text-foreground focus-visible:ring-ring/50 sr-only z-50 rounded-md px-4 py-2 outline-hidden focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus-visible:ring-[3px]"
    >
      Skip to content
    </a>
  );
}
