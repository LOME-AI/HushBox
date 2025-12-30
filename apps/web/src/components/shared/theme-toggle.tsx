import * as React from 'react';
import { useTheme } from '@/providers/theme-provider';

interface IconProps {
  className?: string;
  style?: React.CSSProperties;
  'data-testid'?: string;
}

/**
 * LightMode icon - sun with rays (matches MUI LightMode)
 */
function LightModeIcon({ className, style, 'data-testid': testId }: IconProps): React.JSX.Element {
  return (
    <svg
      data-testid={testId}
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="5" />
      <line
        x1="12"
        y1="1"
        x2="12"
        y2="3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="12"
        y1="21"
        x2="12"
        y2="23"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="4.22"
        y1="4.22"
        x2="5.64"
        y2="5.64"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="18.36"
        y1="18.36"
        x2="19.78"
        y2="19.78"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="1"
        y1="12"
        x2="3"
        y2="12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="21"
        y1="12"
        x2="23"
        y2="12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="4.22"
        y1="19.78"
        x2="5.64"
        y2="18.36"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="18.36"
        y1="5.64"
        x2="19.78"
        y2="4.22"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * DarkMode icon - crescent moon (matches MUI DarkMode)
 */
function DarkModeIcon({ className, style, 'data-testid': testId }: IconProps): React.JSX.Element {
  return (
    <svg
      data-testid={testId}
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M9.37 5.51C9.19 6.15 9.1 6.82 9.1 7.5c0 4.08 3.32 7.4 7.4 7.4.68 0 1.35-.09 1.99-.27C17.45 17.19 14.93 19 12 19c-3.86 0-7-3.14-7-7 0-2.93 1.81-5.45 4.37-6.49zM12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z" />
    </svg>
  );
}

/**
 * Custom theme toggle component with pill shape and animated sliding thumb.
 * Matches LOME-AI styling with 60x30px dimensions.
 */
export function ThemeToggle(): React.JSX.Element {
  const { mode, triggerTransition } = useTheme();
  const isDark = mode === 'dark';

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>): void => {
    triggerTransition({ x: e.clientX, y: e.clientY });
  };

  return (
    <button
      onClick={handleClick}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      data-testid="theme-toggle"
      style={{
        width: '60px',
        height: '30px',
        borderRadius: '15px',
        border: 'none',
        outline: 'none',
        position: 'relative',
        cursor: 'pointer',
        padding: 0,
        backgroundColor: isDark ? '#000000' : '#fef8e0',
        transition: 'background-color 0.3s ease',
        overflow: 'hidden',
      }}
    >
      {/* Track */}
      <div
        className="absolute inset-0"
        style={{
          backgroundColor: isDark ? '#121212' : '#f9f9f9',
          borderRadius: 'inherit',
          boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.2)',
        }}
      >
        {/* Gradient accent line at top */}
        <div
          className="absolute top-0.5 right-0.5 left-0.5 h-0.5 rounded-t"
          style={{
            background: 'linear-gradient(90deg, hsl(var(--primary)), hsl(var(--secondary)))',
            opacity: 0.8,
          }}
        />
      </div>

      {/* Sliding Thumb */}
      <div
        data-testid="thumb"
        className="absolute top-[3px] flex h-6 w-6 items-center justify-center rounded-full transition-all duration-300 ease-in-out hover:scale-110"
        style={{
          left: isDark ? 'calc(100% - 27px)' : '3px',
          backgroundColor: isDark ? 'hsl(var(--secondary))' : 'hsl(var(--primary))',
          boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        }}
      >
        {isDark ? (
          <DarkModeIcon data-testid="dark-mode-icon" className="h-3.5 w-3.5 text-white" />
        ) : (
          <LightModeIcon
            data-testid="light-mode-icon"
            className="h-3.5 w-3.5"
            style={{ color: 'hsl(var(--primary-foreground))' }}
          />
        )}
      </div>

      {/* Label Icons (faded) */}
      <div
        className="absolute top-[7px] left-1.5 transition-opacity duration-300"
        style={{ opacity: isDark ? 0.5 : 0 }}
      >
        <LightModeIcon className="h-4 w-4" style={{ color: 'hsl(var(--primary))' }} />
      </div>
      <div
        className="absolute top-[7px] right-1.5 transition-opacity duration-300"
        style={{ opacity: isDark ? 0 : 0.5 }}
      >
        <DarkModeIcon className="h-4 w-4" style={{ color: 'hsl(var(--secondary))' }} />
      </div>
    </button>
  );
}
