import * as React from 'react';
import { ThemeToggle as BaseThemeToggle } from '@hushbox/ui';
import { useTheme } from '@/providers/theme-provider';

export function ThemeToggle(): React.JSX.Element {
  const { triggerTransition } = useTheme();
  return (
    <BaseThemeToggle
      onToggle={(e) => {
        triggerTransition({ x: e.clientX, y: e.clientY });
      }}
    />
  );
}
