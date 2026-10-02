import { readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { KIT_SECTIONS, kitSectionsFrom, type KitSection } from './kit-sections';

function sectionModule(title: string, part: number): { default: KitSection } {
  return { default: { title, part, render: () => title } };
}

describe('kitSectionsFrom', () => {
  it('yields one section per section module', () => {
    const sections = kitSectionsFrom({
      './button.section.tsx': sectionModule('Buttons', 2),
      './field.section.tsx': sectionModule('Fields', 3),
    });

    expect(sections.map((section) => section.title)).toEqual(['Buttons', 'Fields']);
  });

  it('adds a section when a module is added', () => {
    const before = { './button.section.tsx': sectionModule('Buttons', 2) };
    const after = { ...before, './notice.section.tsx': sectionModule('Notices', 6) };

    expect(kitSectionsFrom(after)).toHaveLength(kitSectionsFrom(before).length + 1);
  });

  it('orders sections by catalog part', () => {
    const sections = kitSectionsFrom({
      './notice.section.tsx': sectionModule('Notices', 6),
      './button.section.tsx': sectionModule('Buttons', 2),
      './field.section.tsx': sectionModule('Fields', 3),
    });

    expect(sections.map((section) => section.part)).toEqual([2, 3, 6]);
  });

  it('orders sections that share a part by title', () => {
    const sections = kitSectionsFrom({
      './menu.section.tsx': sectionModule('Menus', 4),
      './dialog.section.tsx': sectionModule('Dialogs', 4),
    });

    expect(sections.map((section) => section.title)).toEqual(['Dialogs', 'Menus']);
  });
});

describe('KIT_SECTIONS', () => {
  it('holds one section for every section file in the kit directory', () => {
    const sectionFiles = readdirSync(import.meta.dirname).filter((name) =>
      name.endsWith('.section.tsx')
    );

    expect(KIT_SECTIONS).toHaveLength(sectionFiles.length);
  });
});
