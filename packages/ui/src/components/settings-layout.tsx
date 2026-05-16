import * as React from 'react';
import { cn } from '../lib/utilities';
import { useIsMobile } from '../hooks/use-is-mobile';

export interface SettingsNavItem {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

interface SettingsLayoutProps {
  navItems: SettingsNavItem[];
  activeValue: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  pageTitle?: string;
}

/**
 * Two-pane layout used by `/accessibility` and the future `/settings` page.
 *
 * Desktop: left sidebar nav (~240px) + right content column.
 * Mobile: top horizontally-scrollable tab strip (sticky) + content below.
 */
export function SettingsLayout({
  navItems,
  activeValue,
  onChange,
  children,
  pageTitle,
}: Readonly<SettingsLayoutProps>): React.JSX.Element {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <div className="flex min-h-dvh flex-col">
        {pageTitle !== undefined && (
          <h1 className="text-foreground border-border border-b px-4 py-3 text-xl font-bold">
            {pageTitle}
          </h1>
        )}
        <nav
          aria-label="Settings sections"
          className="bg-background border-border sticky top-0 z-10 flex gap-2 overflow-x-auto border-b px-4 py-2"
        >
          {navItems.map((item) => {
            const isActive = item.value === activeValue;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => {
                  onChange(item.value);
                }}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
                  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-foreground-muted hover:bg-accent/50 hover:text-foreground'
                )}
              >
                {item.icon}
                {item.label}
              </button>
            );
          })}
        </nav>
        <main className="flex-1 overflow-auto p-4">{children}</main>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      {pageTitle !== undefined && (
        <h1 className="text-foreground border-border border-b px-6 py-4 text-2xl font-bold">
          {pageTitle}
        </h1>
      )}
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="border-border w-60 shrink-0 overflow-y-auto border-r p-4"
        >
          <ul className="flex flex-col gap-1">
            {navItems.map((item) => {
              const isActive = item.value === activeValue;
              return (
                <li key={item.value}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(item.value);
                    }}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors',
                      'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                      isActive
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground-muted hover:bg-accent/50 hover:text-foreground'
                    )}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
