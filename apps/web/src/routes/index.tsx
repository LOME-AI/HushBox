import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    globalThis.location.href = '/welcome';
  },
});
