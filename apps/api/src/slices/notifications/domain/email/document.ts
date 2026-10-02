import { NEWSLETTER_POSTAL_ADDRESS } from '@hushbox/shared';
import { mapMarkdown, newsletterMarkdownSchema } from './markdown.js';
import type { MarkdownBlock } from './markdown.js';
import type { z } from 'zod';

export type Inline =
  | string
  | { readonly kind: 'link'; readonly text: string; readonly href: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'mono'; readonly text: string };

export type EmailBlock =
  | { readonly kind: 'heading'; readonly text: string }
  | {
      readonly kind: 'paragraph';
      readonly content: readonly Inline[];
      readonly face?: 'serif' | 'mono';
    }
  | { readonly kind: 'finePrint'; readonly content: readonly Inline[] }
  | {
      readonly kind: 'table';
      readonly layout: 'figures' | 'facts';
      readonly rows: readonly (readonly [label: string, value: readonly Inline[]])[];
    }
  | {
      readonly kind: 'table';
      readonly layout: 'log';
      readonly rows: readonly { readonly title: string; readonly meta: readonly Inline[] }[];
    };

export type EmailAction =
  | { readonly kind: 'link'; readonly label: string; readonly href: string }
  | { readonly kind: 'mail'; readonly label: string; readonly address: string };

/**
 * Blocks, then at most one action, then the blocks that follow it. The
 * action-less member names `action` as absent because a definition's `body`
 * returns its literal from a function, where excess-property checks do not
 * reach; without it, that member would accept a body holding a list of actions.
 */
export type EmailBody =
  | {
      readonly blocks: readonly EmailBlock[];
      readonly action?: undefined;
      readonly afterAction?: undefined;
    }
  | {
      readonly blocks: readonly EmailBlock[];
      readonly action: EmailAction;
      readonly afterAction?: readonly EmailBlock[];
    };

/**
 * An email as data: every field is derived from the validated params, and no
 * field carries markup, so the one renderer writes every tag of every email.
 */
export interface StandardEmailDefinition<S extends z.ZodType> {
  readonly kind: 'standard';
  readonly schema: S;
  readonly subject: (p: z.output<S>) => string;
  /** Defaults to the subject, so a heading cannot drift from its subject line. */
  readonly heading?: (p: z.output<S>) => string;
  /** The inbox preview line. */
  readonly preheader: (p: z.output<S>) => string;
  readonly body: (p: z.output<S>) => EmailBody;
}

/** The lines every newsletter issue closes its card with. */
export interface NewsletterIssueFoot {
  readonly unsubscribeUrl: string;
}

/**
 * A newsletter issue: its subject is its heading, its body is markdown the renderer maps
 * onto the email styles, and it has no preview line, so the inbox shows its first text.
 */
export interface NewsletterIssueDefinition<S extends z.ZodType> {
  readonly kind: 'newsletterIssue';
  readonly schema: S;
  readonly subject: (p: z.output<S>) => string;
  readonly markdown: (p: z.output<S>) => string;
  readonly foot: (p: z.output<S>) => NewsletterIssueFoot;
}

export type EmailDefinition<S extends z.ZodType> =
  | StandardEmailDefinition<S>
  | NewsletterIssueDefinition<S>;

export function defineEmail<S extends z.ZodType>(
  definition: StandardEmailDefinition<S>
): StandardEmailDefinition<S> {
  return definition;
}

export function defineNewsletterIssue<S extends z.ZodType>(
  definition: NewsletterIssueDefinition<S>
): NewsletterIssueDefinition<S> {
  return definition;
}

/** What both writers read, so the HTML and text parts cannot see different values. */
export interface ResolvedEmail {
  readonly subject: string;
  readonly heading: string;
  readonly preheader: string | null;
  readonly body: EmailBody;
}

export function resolveEmail<S extends z.ZodType>(
  definition: StandardEmailDefinition<S>,
  params: z.input<S>
): ResolvedEmail {
  const validated = definition.schema.parse(params);
  const subject = definition.subject(validated);
  return {
    subject,
    heading: definition.heading === undefined ? subject : definition.heading(validated),
    preheader: definition.preheader(validated),
    body: definition.body(validated),
  };
}

/** The lines every issue closes its card with, in reading order around the link. */
export interface ResolvedIssueFoot {
  readonly reason: string;
  readonly unsubscribeUrl: string;
  readonly postalLine: string;
}

/**
 * A newsletter issue as both writers read it: the HTML part its blocks, the text part its
 * markdown as a reader sees it, both from one walk of the source (see {@link mapMarkdown}).
 */
export interface ResolvedNewsletterIssue {
  readonly subject: string;
  readonly heading: string;
  readonly blocks: readonly MarkdownBlock[];
  readonly readableMarkdown: string;
  readonly foot: ResolvedIssueFoot;
}

/**
 * Validates the params, then the markdown they yield, so a link the writer would refuse
 * fails here as a validation error and never reaches the writer.
 */
export function resolveNewsletterIssue<S extends z.ZodType>(
  definition: NewsletterIssueDefinition<S>,
  params: z.input<S>
): ResolvedNewsletterIssue {
  const validated = definition.schema.parse(params);
  const subject = definition.subject(validated);
  const markdown = newsletterMarkdownSchema.parse(definition.markdown(validated));
  const mapped = mapMarkdown(markdown);
  return {
    subject,
    heading: subject,
    blocks: mapped.blocks,
    readableMarkdown: mapped.text,
    foot: {
      reason: "You're receiving this because you subscribed at hushbox.ai.",
      unsubscribeUrl: definition.foot(validated).unsubscribeUrl,
      postalLine: `HushBox · ${NEWSLETTER_POSTAL_ADDRESS}`,
    },
  };
}
