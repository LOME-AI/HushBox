import type * as React from 'react';

const HEADING_TAG = { 2: 'h2', 3: 'h3', 4: 'h4' } as const;

/** How deep in the document outline a card's title sits. */
type CardTitleLevel = keyof typeof HEADING_TAG;

/**
 * A card's title as a real heading at the caller's level. It is set in the UI
 * sans, where the base heading style would give it the reading serif, and it
 * carries the red itself so no caller adds a colour class.
 */
function CardTitle({
  level,
  children,
}: Readonly<{ level: CardTitleLevel; children: React.ReactNode }>): React.JSX.Element {
  const Heading = HEADING_TAG[level];
  return (
    <Heading data-slot="card-title" className="text-title-3 text-brand-red font-sans">
      {children}
    </Heading>
  );
}

export { CardTitle, type CardTitleLevel };
