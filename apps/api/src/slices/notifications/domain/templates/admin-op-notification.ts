import { z } from 'zod';
import { adminAuditDayFilter, adminAuditLink } from '@hushbox/shared';
import { defineEmail } from '../email/document.js';
import type { EmailBlock, EmailBody, Inline } from '../email/document.js';

const schema = z.object({
  opName: z.string(),
  actorEmail: z.string(),
  target: z.object({ type: z.string(), id: z.string() }).optional(),
  reason: z.string(),
  occurredAt: z.iso.datetime(),
  isUndo: z.boolean(),
  auditId: z.string(),
  adminUrl: z.url(),
});

type Params = z.output<typeof schema>;

function factsRows(params: Params): (readonly [string, readonly Inline[]])[] {
  return [
    ['Actor', [params.actorEmail]],
    ...(params.target === undefined
      ? []
      : [
          ['Target', [`${params.target.type} `, { kind: 'mono', text: params.target.id }]] as const,
        ]),
    ['Reason', [params.reason]],
    ['At', [params.occurredAt]],
    ['Audit record', [{ kind: 'mono', text: params.auditId }]],
  ];
}

/** Filtered to the target; an operation without one, to its own runs over its UTC day. */
function auditHref(params: Params): string {
  return params.target === undefined
    ? adminAuditLink(params.adminUrl, {
        action: params.opName,
        ...adminAuditDayFilter(params.occurredAt.slice(0, 10)),
      })
    : adminAuditLink(params.adminUrl, { targetId: params.target.id });
}

export const adminOpNotificationEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: (params) =>
    `HushBox Admin · ${params.isUndo ? 'Undo executed' : 'Operation executed'}: ${params.opName}`,
  heading: (params) => (params.isUndo ? 'Admin undo executed' : 'Admin operation executed'),
  preheader: (params) =>
    `${params.actorEmail} ran ${params.opName}. Reason: ${params.reason}${params.reason.endsWith('.') ? '' : '.'}`,
  body: (params): EmailBody => {
    const blocks: EmailBlock[] = [
      { kind: 'paragraph', face: 'mono', content: [params.opName] },
      { kind: 'table', layout: 'facts', rows: factsRows(params) },
    ];
    return {
      blocks,
      action: { kind: 'link', label: 'Open in the audit log', href: auditHref(params) },
    };
  },
});
