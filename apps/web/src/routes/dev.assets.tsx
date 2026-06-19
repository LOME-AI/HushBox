import { createFileRoute, redirect } from '@tanstack/react-router';
import { ROUTES } from '@hushbox/shared';
import { env } from '@/lib/env';
import { AssetsPage } from './-assets-page';

export const Route = createFileRoute('/dev/assets')({
  beforeLoad: () => {
    if (!env.isDev) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: ROUTES.LOGIN });
    }
  },
  component: AssetsPage,
});
