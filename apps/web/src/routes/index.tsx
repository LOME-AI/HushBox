import { createFileRoute, redirect } from '@tanstack/react-router';
import { ROUTES } from '@hushbox/shared';
import { isNative } from '@/capacitor/platform';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    if (isNative()) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is designed to be thrown
      throw redirect({ to: ROUTES.CHAT });
    }
    globalThis.location.href = '/welcome';
  },
});
