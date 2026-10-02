/**
 * Where the panel is drawn. The app's panel lays its grids out from its own width, so the
 * narrow docked pane and a wide page each get the columns they have room for. The site's
 * sheet keeps the viewport step it has always had: its width shrinks as the viewport
 * crosses `sm`, so no threshold on its own width gives it the same columns.
 */
export type AccessibilityHost = 'app' | 'site';

/** The props of a section whose layout depends on where the panel is drawn. */
export interface HostedSectionProps {
  host: AccessibilityHost;
}

/** A section's grid of setting cards. */
export const SECTION_GRID_CLASS: Readonly<Record<AccessibilityHost, string>> = {
  app: 'grid grid-cols-1 gap-2 @a11y-two-col:grid-cols-2',
  site: 'grid grid-cols-1 gap-2 sm:grid-cols-2',
};

/** A setting card that takes the grid's whole row once the grid has two columns. */
export const WIDE_CARD_CLASS: Readonly<Record<AccessibilityHost, string>> = {
  app: '@a11y-two-col:col-span-2',
  site: 'sm:col-span-2',
};

/** The quick-start buttons: a grid in the app, the one column the site has always had. */
export const QUICK_STARTS_CLASS: Readonly<Record<AccessibilityHost, string>> = {
  app: 'grid grid-cols-1 gap-2 @a11y-two-col:grid-cols-2',
  site: 'flex flex-col gap-1.5',
};
