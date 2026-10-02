import { ChevronRight, ChevronsDown, ChevronsUp, Icon } from '@hushbox/ui/icons';
import type * as React from 'react';

interface LegalIndexSection {
  id: string;
  title: string;
}

interface LegalIndexProps {
  sections: readonly LegalIndexSection[];
  allOpen: boolean;
  onToggleAll: () => void;
  hydrated: boolean;
}

const INDEX_BOX = 'border-border mt-6 rounded-lg border px-5 py-4';

function IndexList({
  sections,
}: Readonly<{ sections: readonly LegalIndexSection[] }>): React.JSX.Element {
  return (
    <ol className="mt-3 grid list-none gap-x-8 gap-y-2 p-0 font-sans md:grid-cols-2">
      {sections.map((section, index) => (
        <li key={section.id} className="flex min-w-0 gap-2.5">
          <span aria-hidden="true" className="text-brand-red flex-none font-mono text-xs leading-5">
            {String(index + 1).padStart(2, '0')}
          </span>
          <a
            href={`#${section.id}`}
            className="text-muted-foreground hover:text-brand-red min-w-0 text-sm leading-5 wrap-break-word"
          >
            {section.title}
          </a>
        </li>
      ))}
    </ol>
  );
}

function ToggleAllControl({
  allOpen,
  onToggleAll,
  hydrated,
}: Readonly<Omit<LegalIndexProps, 'sections'>>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggleAll}
      disabled={!hydrated}
      aria-expanded={allOpen}
      className="text-brand-red hover:bg-brand-red-subtle text-ui-sm relative -mx-2 -my-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium disabled:cursor-default disabled:hover:bg-transparent pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:top-1/2 pointer-coarse:before:h-11 pointer-coarse:before:-translate-y-1/2"
    >
      <Icon icon={allOpen ? ChevronsUp : ChevronsDown} size="sm" />
      <span>{allOpen ? 'Hide all details' : 'Show all details'}</span>
    </button>
  );
}

/**
 * The legal page's "On this page" box: a closed disclosure with the control under it on
 * phones, an open box with the control in its head from 768. Both layouts are rendered and
 * the breakpoint shows one, because a native disclosure cannot be held open by CSS alone
 * and the box must read without script.
 */
export function LegalIndex({
  sections,
  allOpen,
  onToggleAll,
  hydrated,
}: Readonly<LegalIndexProps>): React.JSX.Element {
  const control = (
    <ToggleAllControl allOpen={allOpen} onToggleAll={onToggleAll} hydrated={hydrated} />
  );
  return (
    <div>
      <details className={`group ${INDEX_BOX} md:hidden`}>
        {/* On a coarse pointer the hit area grows to the touch floor: 0.875rem up, inside the
            box's top padding, and 0.625rem down, short of the list's top margin. */}
        <summary className="text-foreground relative flex cursor-pointer list-none items-center gap-2 font-sans text-sm font-semibold pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-top-3.5 pointer-coarse:before:-bottom-2.5 [&::-webkit-details-marker]:hidden">
          <Icon
            icon={ChevronRight}
            className="text-muted-foreground transition-transform group-open:rotate-90"
          />
          On this page
        </summary>
        <IndexList sections={sections} />
      </details>
      <div className="mt-3 flex justify-end md:hidden">{control}</div>
      <nav aria-label="On this page" className={`hidden md:block ${INDEX_BOX}`}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* No type role carries the index head's sans 600 at 0.875rem. */}
          <h2 className="text-foreground font-sans text-sm font-semibold">On this page</h2>
          {control}
        </div>
        <IndexList sections={sections} />
      </nav>
    </div>
  );
}
