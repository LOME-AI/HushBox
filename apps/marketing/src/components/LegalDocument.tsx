import * as React from 'react';
import { ChevronDown, Icon } from '@hushbox/ui/icons';
import { ContentSection } from './ui/content-section';
import { Callout } from './ui/callout';
import { LegalIndex } from './legal/LegalIndex';
import type { LegalSection, LegalDocumentMeta } from '@hushbox/shared/legal';

interface LegalDocumentProps {
  meta: LegalDocumentMeta;
  sections: readonly LegalSection[];
  renderAfterSection?: (sectionId: string) => React.ReactNode;
}

export function LegalDocument({
  meta,
  sections,
  renderAfterSection,
}: Readonly<LegalDocumentProps>): React.JSX.Element {
  const [openIds, setOpenIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => {
    setHydrated(true);
  }, []);

  // A link to a section lands on it open, whether it loads the page or moves within it.
  React.useEffect(() => {
    function openNamedSection(): void {
      const named = globalThis.location.hash.slice(1);
      if (!sections.some((section) => section.id === named)) return;
      setOpenIds((previous) => new Set(previous).add(named));
    }
    openNamedSection();
    globalThis.addEventListener('hashchange', openNamedSection);
    return (): void => {
      globalThis.removeEventListener('hashchange', openNamedSection);
    };
  }, [sections]);

  const allOpen = sections.every((section) => openIds.has(section.id));

  function toggleAll(): void {
    setOpenIds(allOpen ? new Set() : new Set(sections.map((section) => section.id)));
  }

  // The disclosure is native so it opens without script; its toggle event keeps the state,
  // and so the control's label, in step with a section the reader opened by hand.
  function syncSection(sectionId: string, open: boolean): void {
    setOpenIds((previous) => {
      const next = new Set(previous);
      if (open) next.add(sectionId);
      else next.delete(sectionId);
      return next;
    });
  }

  return (
    <div>
      <LegalIndex
        sections={sections}
        allOpen={allOpen}
        onToggleAll={toggleAll}
        hydrated={hydrated}
      />

      <div className="mt-12 flex flex-col gap-12">
        {sections.map((section) => (
          <ContentSection key={section.id} title={section.title} id={section.id}>
            <Callout title="Simply Put">{section.simplyPut}</Callout>
            <details
              open={openIds.has(section.id)}
              onToggle={(event): void => {
                syncSection(section.id, event.currentTarget.open);
              }}
              className="group border-border border-b"
            >
              <summary className="text-foreground hover:bg-background-subtle/50 flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg px-2 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                <span>Full details</span>
                <Icon
                  icon={ChevronDown}
                  className="text-muted-foreground transition-transform group-open:rotate-180"
                />
              </summary>
              <ul className="text-foreground text-body-sub marker:text-brand-red mb-4 flex list-disc flex-col gap-2.5 pr-2 pl-7 font-serif">
                {section.points.map((point, pointIndex) => (
                  <li key={`${section.id}-${String(pointIndex)}`}>{point}</li>
                ))}
              </ul>
            </details>
            {renderAfterSection?.(section.id)}
          </ContentSection>
        ))}
      </div>

      <footer className="text-muted-foreground mt-6 pt-6 text-sm">
        <p>
          Questions? Contact us at{' '}
          <a
            href={`mailto:${meta.contactEmail}`}
            className="text-brand-red cursor-pointer hover:underline"
          >
            {meta.contactEmail}
          </a>
        </p>
        <p className="mt-1">LOME-AI LLC, Indiana, United States.</p>
      </footer>
    </div>
  );
}
