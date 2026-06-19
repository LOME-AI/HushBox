import { createFileRoute } from '@tanstack/react-router';
import { VerifyPage } from './-verify-page';

export const Route = createFileRoute('/_auth/verify')({
  component: VerifyPage,
});
