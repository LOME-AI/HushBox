import * as React from 'react';
import { z } from 'zod';
import { Link, createFileRoute, redirect } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ROUTES, TEST_ID_BUILDERS } from '@hushbox/shared';
import { EMAIL_LIGHT_SCHEME_CONDITION } from '@hushbox/shared/design-tokens';
import { Heading } from '@hushbox/ui/type';
import { env } from '@/lib/platform/env';
import { client, fetchJson } from '@/lib/api-client.js';
import { devEmailsKeys } from './-dev-emails-keys';

type EmailScheme = 'dark' | 'light';

const SCHEMES: readonly EmailScheme[] = ['dark', 'light'];

/** Both keys are optional, so a link to the list needs no search. */
export interface EmailsSearch {
  view?: string;
  scheme?: EmailScheme;
}

const viewSchema = z.string();
const schemeSchema = z.enum(['dark', 'light']);

function parseEmailsSearch(search: Record<string, unknown>): EmailsSearch {
  const view = viewSchema.safeParse(search['view']);
  const scheme = schemeSchema.safeParse(search['scheme']);
  return {
    ...(view.success && { view: view.data }),
    ...(scheme.success && { scheme: scheme.data }),
  };
}

export const Route = createFileRoute('/dev/emails')({
  validateSearch: parseEmailsSearch,
  beforeLoad: () => {
    if (!env.isDev) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is designed to be thrown
      throw redirect({ to: ROUTES.LOGIN });
    }
  },
  component: EmailsPage,
});

interface EmailTemplate {
  name: string;
  label: string;
  html: string;
}

interface EmailsResponse {
  templates: EmailTemplate[];
}

/**
 * Chromium applies neither an iframe's `color-scheme` nor its parent's to
 * `prefers-color-scheme` inside the frame, so each frame pins the light variant on or off
 * in the email's own style instead of relying on the viewer's preference.
 */
function pinScheme(html: string, scheme: EmailScheme): string {
  return html.replaceAll(
    EMAIL_LIGHT_SCHEME_CONDITION,
    scheme === 'light' ? '@media all' : '@media not all'
  );
}

function frameTitle(template: EmailTemplate, scheme: EmailScheme): string {
  return `${template.label} email template preview, ${scheme}`;
}

function EmailsPage(): React.JSX.Element {
  // The router lays the root's raw search under the keys this route validated, so a key
  // the validator dropped comes back raw; parsing again keeps only valid keys.
  const { view, scheme } = parseEmailsSearch(Route.useSearch());
  const { data, isLoading, isError } = useQuery({
    queryKey: devEmailsKeys.all,
    queryFn: (): Promise<EmailsResponse> => fetchJson(client.dev.emails.$get()),
    enabled: env.isDev,
    retry: false,
  });

  if (isLoading) {
    return <StatusPage message="Loading email templates..." />;
  }

  if (isError) {
    return <StatusPage message="Failed to load email templates. Please try again." tone="error" />;
  }

  const templates = data?.templates ?? [];

  if (templates.length === 0) {
    return <StatusPage message="No email templates found." />;
  }

  const viewed = templates.find((template) => template.name === view);
  if (viewed !== undefined && scheme !== undefined) {
    return <FullView template={viewed} scheme={scheme} />;
  }

  return (
    <div className="bg-background min-h-full px-4 py-8 md:px-8">
      <div className="mx-auto flex max-w-6xl flex-col">
        <Heading level={1} variant="title-1">
          Email Templates
        </Heading>
        <p className="text-ui text-muted-foreground mt-2">{String(templates.length)} templates</p>

        <div className="mt-10 flex flex-col gap-14">
          {templates.map((template) => (
            <TemplatePreview key={template.name} template={template} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusPage({
  message,
  tone = 'muted',
}: Readonly<{ message: string; tone?: 'muted' | 'error' }>): React.JSX.Element {
  return (
    <div className="bg-background flex min-h-full flex-col items-center justify-center gap-6 p-8">
      <Heading level={1} variant="title-1">
        Email Templates
      </Heading>
      <p
        className={tone === 'error' ? 'text-destructive text-ui' : 'text-muted-foreground text-ui'}
      >
        {message}
      </p>
    </div>
  );
}

function TemplatePreview({ template }: Readonly<{ template: EmailTemplate }>): React.JSX.Element {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId}>
      <Heading level={2} variant="title-2" id={headingId}>
        {template.label}
      </Heading>
      <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
        {SCHEMES.map((scheme) => (
          <SchemeFrame key={scheme} template={template} scheme={scheme} />
        ))}
      </div>
    </section>
  );
}

function SchemeFrame({
  template,
  scheme,
}: Readonly<{ template: EmailTemplate; scheme: EmailScheme }>): React.JSX.Element {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="flex flex-col gap-1">
        <span className="text-caption text-muted-foreground font-mono">{scheme}</span>
        <Link
          to={ROUTES.DEV_EMAILS}
          search={{ view: template.name, scheme }}
          aria-label={`Open at full width: ${template.label}, ${scheme}`}
          className="text-ui text-primary self-start underline-offset-4 hover:underline"
        >
          Open at full width
        </Link>
      </figcaption>
      <iframe
        data-testid={TEST_ID_BUILDERS.emailSchemeIframe(template.name, scheme)}
        title={frameTitle(template, scheme)}
        srcDoc={pinScheme(template.html, scheme)}
        sandbox=""
        className={`border-border h-[600px] w-full rounded-lg border ${scheme === 'dark' ? 'scheme-dark' : 'scheme-light'}`}
      />
    </figure>
  );
}

function FullView({
  template,
  scheme,
}: Readonly<{ template: EmailTemplate; scheme: EmailScheme }>): React.JSX.Element {
  return (
    <iframe
      data-testid={TEST_ID_BUILDERS.emailSchemeIframe(template.name, scheme)}
      title={frameTitle(template, scheme)}
      srcDoc={pinScheme(template.html, scheme)}
      sandbox=""
      className={`block h-full w-full border-0 ${scheme === 'dark' ? 'scheme-dark' : 'scheme-light'}`}
    />
  );
}
