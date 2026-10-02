import type { LegalDocumentMeta, LegalSection } from './types.ts';

// ASCII unit and record separators: published prose is ordinary text and can hold neither,
// so no field's own content can imitate a boundary and hide text moving across one.
const FIELD_SEPARATOR = '\u001F';
const RECORD_SEPARATOR = '\u001E';

/**
 * Everything a reader of the document sees, in reading order: the title, the contact
 * address, and every section's anchor, heading, summary and points.
 *
 * The effective date is excluded deliberately. The digest is what decides whether a new
 * effective date is owed, so digesting the date would make the answer depend on itself.
 */
function renderedCopy(meta: LegalDocumentMeta, sections: readonly LegalSection[]): string {
  return [
    meta.title,
    meta.contactEmail,
    ...sections.map((section) =>
      [section.id, section.title, section.simplyPut, ...section.points].join(FIELD_SEPARATOR)
    ),
  ].join(RECORD_SEPARATOR);
}

/**
 * SHA-256 over the rendered copy, lowercase hex.
 *
 * Taken over the rendered strings rather than the source file, so that how the prose is
 * spelled in TypeScript — an escape sequence or the character it denotes — cannot move the
 * digest, while a clause the source computes from a constant it imports does.
 */
export async function legalCopyDigest(
  meta: LegalDocumentMeta,
  sections: readonly LegalSection[]
): Promise<string> {
  const bytes = new TextEncoder().encode(renderedCopy(meta, sections));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
