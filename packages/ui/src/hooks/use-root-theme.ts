import * as React from 'react';

type RootTheme = 'dark' | 'light';

function readRootTheme(): RootTheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * There is no root element to read while server-rendering, and the value React
 * uses here is also the one the hydration pass must agree with, so it has to be
 * the value the emitted HTML was built from. `ThemeToggle` ships as a
 * `client:load` island on the Astro marketing site, which makes that path real
 * rather than hypothetical.
 */
function readServerRootTheme(): RootTheme {
  return 'light';
}

function subscribeToRootTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => {
    observer.disconnect();
  };
}

/**
 * The app's theme is a `dark` class on the root element, switchable in the UI and
 * independent of `prefers-color-scheme`. Every consumer that renders differently
 * in dark mode reads it through here: two readings of the same fact would have to
 * agree to be correct, and would silently disagree the day the convention moves.
 */
function useRootTheme(): RootTheme {
  return React.useSyncExternalStore(subscribeToRootTheme, readRootTheme, readServerRootTheme);
}

export { useRootTheme };
