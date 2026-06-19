import { createFileRoute, redirect } from '@tanstack/react-router';
import { ROUTES } from '@hushbox/shared';
import { env } from '@/lib/env';
import { EmailsPage } from './-emails-page';

export const Route = createFileRoute('/dev/emails')({
  beforeLoad: () => {
    if (!env.isDev) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: ROUTES.LOGIN });
    }
  },
  component: EmailsPage,
});
