import { Accordion } from '@hushbox/ui';
import { ContentSection } from './ui/content-section';
import { Callout } from './ui/callout';
import { ScrollReveal } from './ui/scroll-reveal';
import { SectionNav } from './ui/section-nav';
import type { LegalSection, LegalDocumentMeta } from '@hushbox/shared/legal';

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
      <SectionNav sections={navSections} className="flex-wrap" />

      <div className="space-y-12">
        {sections.map((section, index) => (
          <ScrollReveal key={section.id} animation="fade-up" delay={index * 50}>
            <ContentSection title={section.title} id={section.id}>
              <Callout variant="privacy" title="Simply Put">
                {section.simplyPut}
              </Callout>
              <Accordion trigger="Full details">
                <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-sm">
                  {section.points.map((point, pointIndex) => (
                    <li key={`${section.id}-${String(pointIndex)}`}>{point}</li>
                  ))}
                </ul>
              </Accordion>
              {renderAfterSection?.(section.id)}
            </ContentSection>
          </ScrollReveal>
        ))}
      </div>

      <footer className="text-muted-foreground pt-6 text-sm">
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
