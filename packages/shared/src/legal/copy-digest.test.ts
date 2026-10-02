import { describe, it, expect } from 'vitest';

import { legalCopyDigest } from './copy-digest.ts';
import type { LegalDocumentMeta, LegalSection } from './types.ts';

const META: LegalDocumentMeta = {
  title: 'Sample Policy',
  effectiveDate: '2026-01-01',
  contactEmail: 'sample@hushbox.ai',
};

const SECTIONS: readonly LegalSection[] = [
  {
    id: 'first',
    title: 'First Section',
    simplyPut: 'The short version.',
    points: ['One published sentence.', 'A second published sentence.'],
  },
];

describe('legalCopyDigest', () => {
  it('renders a document as a lowercase hex SHA-256 digest', async () => {
    expect(await legalCopyDigest(META, SECTIONS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a published point changes', async () => {
    const edited: readonly LegalSection[] = [
      { ...SECTIONS[0]!, points: ['One published sentence.', 'A rewritten second sentence.'] },
    ];
    expect(await legalCopyDigest(META, edited)).not.toBe(await legalCopyDigest(META, SECTIONS));
  });

  it('ignores the effective date', async () => {
    const laterDate: LegalDocumentMeta = { ...META, effectiveDate: '2026-06-30' };
    expect(await legalCopyDigest(laterDate, SECTIONS)).toBe(await legalCopyDigest(META, SECTIONS));
  });

  it('changes when the document title changes', async () => {
    const retitled: LegalDocumentMeta = { ...META, title: 'Sample Policy and Notice' };
    expect(await legalCopyDigest(retitled, SECTIONS)).not.toBe(
      await legalCopyDigest(META, SECTIONS)
    );
  });

  it('changes when the contact address changes', async () => {
    const readdressed: LegalDocumentMeta = { ...META, contactEmail: 'legal@hushbox.ai' };
    expect(await legalCopyDigest(readdressed, SECTIONS)).not.toBe(
      await legalCopyDigest(META, SECTIONS)
    );
  });

  // Two points merged into one read differently and must digest differently: a renderer
  // that concatenated the fields with a character the copy may itself contain would
  // collide here, and the digest would go blind to text moving across a field boundary.
  it('changes when two points are merged into one', async () => {
    const merged: readonly LegalSection[] = [
      { ...SECTIONS[0]!, points: ['One published sentence. A second published sentence.'] },
    ];
    expect(await legalCopyDigest(META, merged)).not.toBe(await legalCopyDigest(META, SECTIONS));
  });
});
