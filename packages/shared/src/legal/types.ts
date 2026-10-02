/** A single section in a legal document (Privacy Policy or Terms of Service) */
export interface LegalSection {
  /** Unique identifier for anchor links */
  readonly id: string;
  /** Section title displayed as heading */
  readonly title: string;
  /** Plain-language summary shown in the "Simply Put" callout */
  readonly simplyPut: string;
  /** Key points to display in the section body */
  readonly points: readonly string[];
}

/** Metadata for a legal document */
export interface LegalDocumentMeta {
  /** Document title */
  title: string;
  /** Effective date (YYYY-MM-DD), derived per build — `./effective-dates.ts` */
  effectiveDate: string;
  /** Contact email for inquiries */
  contactEmail: string;
}
