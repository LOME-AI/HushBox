import { z } from 'zod';
import { adminAuditDayFilter, adminAuditLink } from '@hushbox/shared';
import { defineEmail } from '../email/document.js';
import type { EmailBlock, EmailBody, Inline } from '../email/document.js';

const actionSchema = z.object({
  opName: z.string(),
  actorEmail: z.string(),
  target: z.object({ type: z.string(), id: z.string() }).optional(),
  occurredAt: z.iso.datetime(),
});

export type AdminDigestAction = z.input<typeof actionSchema>;

const schema = z.object({
  day: z.iso.date(),
  actions: z.array(actionSchema),
  adminUrl: z.url(),
});

type Action = z.output<typeof actionSchema>;

/** The preview line names at most this many distinct ops before "and N more". */
const PREVIEW_OP_LIMIT = 3;

/** "a", "a and b", "a, b and c". */
function joinNames(names: readonly string[]): string {
  const head = names.slice(0, -1);
  const last = names.slice(-1).join('');
  return head.length === 0 ? last : `${head.join(', ')} and ${last}`;
}

function previewOps(actions: readonly Action[]): string {
  const ops = [...new Set(actions.map((action) => action.opName))];
  if (ops.length <= PREVIEW_OP_LIMIT) return joinNames(ops);
  return `${ops.slice(0, PREVIEW_OP_LIMIT).join(', ')} and ${String(ops.length - PREVIEW_OP_LIMIT)} more`;
}

function previewLine(actions: readonly Action[]): string {
  const [first] = actions;
  if (first === undefined) return 'No admin actions.';
  if (actions.length === 1) return `${first.opName} by ${first.actorEmail}.`;
  const admins = new Set(actions.map((action) => action.actorEmail));
  if (admins.size > 1) return `${previewOps(actions)} by ${String(admins.size)} admins.`;
  const quantifier = actions.length === 2 ? 'both' : 'all';
  return `${previewOps(actions)}, ${quantifier} by ${first.actorEmail}.`;
}

function countLine(day: string, count: number): string {
  if (count === 0) return `No admin actions executed on ${day}.`;
  return `${String(count)} admin action${count === 1 ? '' : 's'} executed on ${day}.`;
}

function logMeta(action: Action): readonly Inline[] {
  return [
    `by ${action.actorEmail} `,
    ...(action.target === undefined
      ? []
      : [`on ${action.target.type} `, { kind: 'mono', text: action.target.id } as const, ' ']),
    `at ${action.occurredAt}`,
  ];
}

export const adminDailyDigestEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: (params) => `HushBox Admin · Daily audit digest for ${params.day}`,
  heading: () => 'Daily admin digest',
  preheader: (params) => previewLine(params.actions),
  body: (params): EmailBody => {
    const blocks: EmailBlock[] = [
      { kind: 'paragraph', content: [countLine(params.day, params.actions.length)] },
      ...(params.actions.length === 0
        ? []
        : [
            {
              kind: 'table',
              layout: 'log',
              rows: params.actions.map((action) => ({
                title: action.opName,
                meta: logMeta(action),
              })),
            } as const,
          ]),
    ];
    return {
      blocks,
      action: {
        kind: 'link',
        label: 'Open in the audit log',
        href: adminAuditLink(params.adminUrl, adminAuditDayFilter(params.day)),
      },
    };
  },
});
