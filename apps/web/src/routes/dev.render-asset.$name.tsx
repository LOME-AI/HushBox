import { createFileRoute, redirect } from '@tanstack/react-router';
import { ROUTES } from '@hushbox/shared';
import { env } from '@/lib/env';
import { RenderAssetPage } from './-render-asset-page';

export const Route = createFileRoute('/dev/render-asset/$name')({
  beforeLoad: () => {
    if (!env.isDev) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: ROUTES.LOGIN });
    }
  },
  component: RenderAssetPage,
});
