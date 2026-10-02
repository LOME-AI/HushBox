import { z } from 'zod';
import { defineNewsletterIssue } from '../email/document.js';

const schema = z.object({
  subject: z.string(),
  bodyMarkdown: z.string(),
  unsubscribeUrl: z.string(),
});

export type NewsletterIssueParams = z.input<typeof schema>;

export const newsletterIssueEmail = defineNewsletterIssue({
  kind: 'newsletterIssue',
  schema,
  subject: (params) => params.subject,
  markdown: (params) => params.bodyMarkdown,
  foot: (params) => ({ unsubscribeUrl: params.unsubscribeUrl }),
});
