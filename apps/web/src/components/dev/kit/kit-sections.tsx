import type * as React from 'react';

/** What every `<name>.section.tsx` file in this directory exports as its default. */
export interface KitSection {
  title: string;
  /** The catalog part the section is compared against. */
  part: number;
  render: () => React.ReactNode;
}

interface KitSectionModule {
  default: KitSection;
}

export function kitSectionsFrom(modules: Record<string, KitSectionModule>): KitSection[] {
  return Object.values(modules)
    .map((module) => module.default)
    .toSorted((a, b) => a.part - b.part || a.title.localeCompare(b.title));
}

export const KIT_SECTIONS: readonly KitSection[] = kitSectionsFrom(
  import.meta.glob<KitSectionModule>('./*.section.tsx', { eager: true })
);
