import * as React from 'react';
import { useState } from 'react';
import { Accessibility } from 'lucide-react';

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../sheet';
import { SidebarPanelHeader } from '../sidebar-panel';
import { AccessibilityPanel } from './accessibility-panel';

/**
 * Floating accessibility widget for the marketing site (and any other surface
 * that wants the panel without a sidebar slot). Renders a fixed bottom-left
 * trigger button; clicking it opens a left-side sheet wrapping
 * {@link AccessibilityPanel}, with a {@link SidebarPanelHeader} providing the
 * close affordance. The Sheet's built-in close button is suppressed because
 * the header already owns one.
 */
export function AccessibilityWidget(): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={(): void => {
          setOpen(true);
        }}
        className="bg-brand-red focus-visible:outline-brand-red fixed bottom-4 left-4 z-50 flex h-12 w-12 items-center justify-center rounded-full text-white shadow-lg hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2"
        aria-label="Accessibility settings"
      >
        <Accessibility className="h-6 w-6" aria-hidden="true" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          className="bg-sidebar text-sidebar-foreground flex w-[85%] flex-col gap-0 p-0 sm:w-auto sm:max-w-md"
          showCloseButton={false}
        >
          <SheetTitle className="sr-only">Accessibility settings</SheetTitle>
          <SheetDescription className="sr-only">
            Adjust visual, audio, motion, pointer and reading preferences for this site.
          </SheetDescription>
          <SidebarPanelHeader
            side="left"
            collapsed={false}
            headerTitle="Accessibility"
            onClose={(): void => {
              setOpen(false);
            }}
          />
          <div className="flex min-h-0 flex-1 flex-col overflow-auto p-2">
            <AccessibilityPanel />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
