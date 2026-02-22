/** A single section in a legal document (Privacy Policy or Terms of Service) */
export interface LegalSection {
  /** Unique identifier for anchor links */
  id: string;
  /** Section title displayed as heading */
  title: string;
  /** Plain-language summary shown in the "Simply Put" callout */
  simplyPut: string;
  /** Key points to display in the section body */
  points: string[];
}

/** Metadata for a legal document */
export interface LegalDocumentMeta {
  /** Document title */
  title: string;
  /** Effective date (YYYY-MM-DD) imported from constants */
  effectiveDate: string;
  /** Contact email for inquiries */
  contactEmail: string;
}
