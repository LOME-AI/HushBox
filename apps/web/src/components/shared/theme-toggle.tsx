import * as React from 'react';
import { useTheme } from '@/providers/theme-provider';

/**
 * Sun/Moon morph theme toggle.
 * Single SVG icon that smoothly morphs between sun (light) and crescent moon (dark)
 * using CSS transitions on SVG properties and a mask-based cutout.
 */
export function ThemeToggle(): React.JSX.Element {
  const { mode, triggerTransition } = useTheme();
  const isDark = mode === 'dark';
  const maskId = `theme-mask-${React.useId()}`;

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>): void => {
    triggerTransition({ x: e.clientX, y: e.clientY });
  };

  return (
    <button
      onClick={handleClick}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      data-testid="theme-toggle"
      className="text-foreground hover:bg-accent hover:text-accent-foreground inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border-none bg-transparent p-0 transition-colors outline-none"
    >
      <svg
        data-testid="theme-morph-icon"
        viewBox="0 0 24 24"
        fill="currentColor"
        xmlns="http://www.w3.org/2000/svg"
        className="h-5 w-5"
      >
        <defs>
          <mask id={maskId}>
            <rect width="24" height="24" fill="white" />
            <circle
              data-testid="mask-circle"
              cx={isDark ? '17' : '28'}
              cy={isDark ? '7' : '0'}
              r="9"
              fill="black"
              style={{
                transition: 'cx 500ms ease-in-out, cy 500ms ease-in-out',
              }}
            />
          </mask>
        </defs>

        {/* Sun body / Moon body */}
        <circle
          data-testid="sun-body"
          cx="12"
          cy="12"
          r={isDark ? '8' : '5'}
          mask={`url(#${maskId})`}
          fill="currentColor"
          style={{ transition: 'r 500ms ease-in-out' }}
        />

        {/* Sun rays — retract and rotate in dark mode */}
        <g
          data-testid="sun-rays"
          style={{
            transform: isDark ? 'rotate(45deg) scale(0)' : 'rotate(0deg) scale(1)',
            transformOrigin: '12px 12px',
            transition: 'transform 500ms ease-in-out',
          }}
        >
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
        </g>
      </svg>
    </button>
  );
}
