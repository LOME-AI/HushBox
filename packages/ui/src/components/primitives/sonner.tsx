import * as React from 'react';
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useRootTheme } from '../../hooks/use-root-theme';

/**
 * Sonner's own `'system'` theme resolves from `prefers-color-scheme`, which is
 * not what this app's theme is: the theme is a `dark` class on the root element
 * and is switchable independently of the OS. Defaulting to the class means no
 * mount site can get it wrong; an explicit `theme` prop still wins, which is the
 * escape hatch for a consumer that themes some other way.
 */
function Toaster({ theme, ...props }: Readonly<ToasterProps>): React.JSX.Element {
  const rootTheme = useRootTheme();

  return (
    <Sonner
      data-slot="toaster"
      theme={theme ?? rootTheme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--color-popover)',
          '--normal-text': 'var(--color-popover-foreground)',
          '--normal-border': 'var(--color-border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
