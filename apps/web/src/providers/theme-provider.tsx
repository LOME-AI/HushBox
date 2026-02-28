import * as React from 'react';
import { triggerViewTransition } from '@hushbox/ui';

type ThemeMode = 'light' | 'dark';

interface ThemeContextType {
  mode: ThemeMode;
  triggerTransition: (origin: { x: number; y: number }) => void;
}

const defaultContextValue: ThemeContextType = {
  mode: 'light',
  triggerTransition: () => {
    console.warn('ThemeProvider context not available');
  },
};

const ThemeContext = React.createContext<ThemeContextType>(defaultContextValue);

export function useTheme(): ThemeContextType {
  return React.useContext(ThemeContext);
}

interface ThemeProviderProps {
  children: React.ReactNode;
}

export function ThemeProvider({
  children,
}: Readonly<ThemeProviderProps>): React.JSX.Element | null {
  const [mode, setModeInternal] = React.useState<ThemeMode>('light');
  const [mounted, setMounted] = React.useState(false);
  const isTransitioning = React.useRef(false);

  // Initialize theme from localStorage or system preference
  React.useEffect(() => {
    let initialMode: ThemeMode = 'light';
    try {
      const savedMode = localStorage.getItem('themeMode');
      if (savedMode === 'light' || savedMode === 'dark') {
        initialMode = savedMode;
      } else if (globalThis.matchMedia('(prefers-color-scheme: dark)').matches) {
        initialMode = 'dark';
      }
    } catch (error) {
      console.error('Error accessing localStorage:', error);
    }
    setModeInternal(initialMode);
    setMounted(true);
  }, []);

  // Function to apply theme mode to DOM and localStorage
  const applyTheme = React.useCallback((newMode: ThemeMode) => {
    try {
      localStorage.setItem('themeMode', newMode);
    } catch (error) {
      console.error('Error saving themeMode to localStorage:', error);
    }
    setModeInternal(newMode);
    document.documentElement.dataset['theme'] = newMode;

    // Update the class on document for Tailwind dark mode
    document.documentElement.classList.toggle('dark', newMode === 'dark');
  }, []);

  /**
   * Triggers the theme transition using the View Transitions API.
   * Falls back to instant theme change if API is not supported.
   */
  const triggerTransition = React.useCallback(
    (origin: { x: number; y: number }) => {
      if (isTransitioning.current) return;
      isTransitioning.current = true;

      const newMode = mode === 'light' ? 'dark' : 'light';
      triggerViewTransition(origin, () => {
        applyTheme(newMode);
      });

      // Reset transitioning flag after animation duration
      setTimeout(() => {
        isTransitioning.current = false;
      }, 1500);
    },
    [mode, applyTheme]
  );

  // Set data-theme attribute on HTML element
  React.useEffect(() => {
    if (mounted) {
      document.documentElement.dataset['theme'] = mode;
      document.documentElement.classList.toggle('dark', mode === 'dark');
    }
  }, [mode, mounted]);

  // Context value
  const contextValue = React.useMemo(
    () => ({
      mode,
      triggerTransition,
    }),
    [mode, triggerTransition]
  );

  if (!mounted) {
    return null;
  }

  return <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>;
}
