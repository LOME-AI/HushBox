import type { LegalSection, LegalDocumentMeta } from '@hushbox/shared/legal';
import { ContentSection, Callout, Accordion, ScrollReveal, SectionNav } from '@hushbox/ui';

interface LegalDocumentProps {
  meta: LegalDocumentMeta;
  sections: LegalSection[];
  renderAfterSection?: (sectionId: string) => React.ReactNode;
}

export function LegalDocument({
  meta,
  sections,
  renderAfterSection,
}: Readonly<LegalDocumentProps>): React.JSX.Element {
  const navSections = sections.map((s) => ({ id: s.id, label: s.title }));

  return (
    <div className="space-y-8">
      <div className="border-b pb-6">
        <h1 className="text-3xl font-bold">{meta.title}</h1>
        <p className="text-foreground-muted mt-2 text-sm">Effective: {meta.effectiveDate}</p>
      </div>

      <SectionNav sections={navSections} className="flex-wrap" />

      <div className="space-y-12">
        {sections.map((section, index) => (
          <ScrollReveal key={section.id} animation="fade-up" delay={index * 50}>
            <ContentSection title={section.title} id={section.id}>
              <Callout variant="privacy" title="Simply Put">
                {section.simplyPut}
              </Callout>
              <Accordion trigger="Full details">
                <ul className="text-foreground-muted list-disc space-y-2 pl-5 text-sm">
                  {section.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </Accordion>
              {renderAfterSection?.(section.id)}
            </ContentSection>
          </ScrollReveal>
        ))}
      </div>

      <footer className="text-foreground-muted border-t pt-6 text-sm">
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
