import { createFileRoute, redirect } from '@tanstack/react-router';
import { ROUTES } from '@hushbox/shared';
import { env } from '@/lib/env';
import { PersonasPage } from './-personas-page';

export interface PersonasSearch {
  type: string | undefined;
}

export const Route = createFileRoute('/dev/personas')({
  validateSearch: (search: Record<string, unknown>): PersonasSearch => ({
    type: typeof search['type'] === 'string' ? search['type'] : undefined,
  }),
  beforeLoad: () => {
    if (!env.isDev) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: ROUTES.LOGIN });
    }
  },
  component: PersonasPage,
});
