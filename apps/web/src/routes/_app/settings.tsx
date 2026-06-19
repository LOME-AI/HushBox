import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '@/lib/auth';
import { SettingsPage } from './-settings-page';

export const Route = createFileRoute('/_app/settings')({
  beforeLoad: async () => {
    await requireAuth();
  },
  component: SettingsPage,
});
