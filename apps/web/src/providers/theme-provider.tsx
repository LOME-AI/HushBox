import * as React from 'react';

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

/**
 * Check if View Transitions API is supported.
 * Returns true for Chrome 111+, Edge 111+, Safari 18+
 */
function supportsViewTransitions(): boolean {
  return typeof document !== 'undefined' && 'startViewTransition' in document;
}

export function ThemeProvider({ children }: ThemeProviderProps): React.JSX.Element | null {
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
      } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
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
    document.documentElement.setAttribute('data-theme', newMode);

    // Update the class on document for Tailwind dark mode
    if (newMode === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, []);

  /**
   * Triggers the theme transition using the View Transitions API.
   * Falls back to instant theme change if API is not supported.
   */
  const triggerTransition = React.useCallback(
    (origin: { x: number; y: number }) => {
      // Prevent triggering if already transitioning
      if (isTransitioning.current) return;

      const newMode = mode === 'light' ? 'dark' : 'light';

      // If View Transitions API is not supported, just change theme instantly
      if (!supportsViewTransitions()) {
        applyTheme(newMode);
        return;
      }

      isTransitioning.current = true;

      // Calculate the maximum radius needed to cover the entire viewport
      const maxRadius = Math.max(
        Math.hypot(origin.x, origin.y),
        Math.hypot(window.innerWidth - origin.x, origin.y),
        Math.hypot(origin.x, window.innerHeight - origin.y),
        Math.hypot(window.innerWidth - origin.x, window.innerHeight - origin.y)
      );

      // Set CSS custom properties for the animation origin and radius
      document.documentElement.style.setProperty('--transition-x', `${String(origin.x)}px`);
      document.documentElement.style.setProperty('--transition-y', `${String(origin.y)}px`);
      document.documentElement.style.setProperty('--transition-radius', `${String(maxRadius)}px`);

      // Use View Transitions API
      const transition = document.startViewTransition(() => {
        applyTheme(newMode);
      });

      // Clean up after transition
      transition.finished
        .then(() => {
          isTransitioning.current = false;
          document.documentElement.style.removeProperty('--transition-x');
          document.documentElement.style.removeProperty('--transition-y');
          document.documentElement.style.removeProperty('--transition-radius');
        })
        .catch(() => {
          isTransitioning.current = false;
          document.documentElement.style.removeProperty('--transition-x');
          document.documentElement.style.removeProperty('--transition-y');
          document.documentElement.style.removeProperty('--transition-radius');
        });
    },
    [mode, applyTheme]
  );

  // Set data-theme attribute on HTML element
  React.useEffect(() => {
    if (mounted) {
      document.documentElement.setAttribute('data-theme', mode);
      if (mode === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
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
