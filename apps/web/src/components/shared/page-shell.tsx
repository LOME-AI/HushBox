import * as React from 'react';
import { HamburgerButton } from '@/components/sidebar/hamburger-button';
import { MoreOptionsMenu } from '@/components/shared/more-options-menu';
import { ThemeToggle } from '@/components/shared/theme-toggle';

type PageSlotName = 'title' | 'center' | 'shield' | 'facepile' | 'newChat' | 'strip';

type PageSlots = Readonly<Record<PageSlotName, HTMLElement | null>>;

interface PageShellContextValue {
  slots: PageSlots;
  setHeaderTestId: (testId: string | undefined) => void;
}

/** The slots a page's `PageHeader` portals into; null outside a `PageShell`. */
export const PageShellContext = React.createContext<PageShellContextValue | null>(null);

interface PageShellProps {
  /** Pages outside the app layout have no drawer to open. */
  menuButton?: boolean;
  children: React.ReactNode;
}

/**
 * One header row, a strip below it on phones, then the page. The header draws the
 * controls every page shares; a page fills the rest through `PageHeader`.
 */
export function PageShell({
  menuButton = true,
  children,
}: Readonly<PageShellProps>): React.JSX.Element {
  // Each slot's element arrives through a state setter used as its callback ref, so a
  // page's portals render once the element exists.
  const [title, setTitle] = React.useState<HTMLElement | null>(null);
  const [center, setCenter] = React.useState<HTMLElement | null>(null);
  const [shield, setShield] = React.useState<HTMLElement | null>(null);
  const [facepile, setFacepile] = React.useState<HTMLElement | null>(null);
  const [newChat, setNewChat] = React.useState<HTMLElement | null>(null);
  const [strip, setStrip] = React.useState<HTMLElement | null>(null);
  const [headerTestId, setHeaderTestId] = React.useState<string | undefined>();
  const context = React.useMemo(
    () => ({ slots: { title, center, shield, facepile, newChat, strip }, setHeaderTestId }),
    [title, center, shield, facepile, newChat, strip]
  );

  return (
    <PageShellContext value={context}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* One row; at large text sizes the controls wrap to a second row rather than
            overlap. */}
        <header
          data-testid={headerTestId ?? 'page-header'}
          data-chrome=""
          className="group/app-header bg-background @container/app-header flex min-h-[var(--app-header-height)] shrink-0 flex-wrap content-center items-center gap-x-1 gap-y-1 border-b py-1 pr-2 pl-1 md:gap-x-2 md:px-4"
        >
          {menuButton && <HamburgerButton />}
          <div
            ref={setTitle}
            data-page-slot="title"
            className="flex min-w-0 flex-1 items-center group-has-[[data-page-slot=center]:not(:empty)]/app-header:max-w-max"
          />
          {/* While a page fills the centre, the title stops at its text so the centre
              follows it, and the controls keep to the header's end. */}
          <div
            ref={setCenter}
            data-page-slot="center"
            className="flex min-w-0 shrink-0 items-center empty:hidden"
          />
          <div className="flex shrink-0 items-center justify-end gap-2 group-has-[[data-page-slot=center]:not(:empty)]/app-header:ms-auto">
            <div
              ref={setShield}
              data-page-slot="shield"
              className="flex items-center empty:hidden"
            />
            <ThemeToggle />
            {/* Shown at every width while it is a phone's only way to the member list. */}
            <div
              ref={setFacepile}
              data-page-slot="facepile"
              className="flex items-center empty:hidden"
            />
            <div
              ref={setNewChat}
              data-page-slot="new-chat"
              className="@max-header-new-chat/app-header:hidden flex items-center empty:hidden md:hidden"
            />
            <MoreOptionsMenu />
          </div>
        </header>
        <div ref={setStrip} data-page-slot="strip" className="empty:hidden md:hidden" />
        <div data-page-slot="region" className="flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </div>
    </PageShellContext>
  );
}
