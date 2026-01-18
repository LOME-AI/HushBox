import { createFileRoute, redirect } from '@tanstack/react-router';
import { ROUTES } from '@/lib/routes';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    // TanStack Router requires throwing redirect objects
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: ROUTES.CHAT });
  },
});
