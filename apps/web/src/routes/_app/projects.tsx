import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '@/lib/auth';

export const Route = createFileRoute('/_app/projects')({
  beforeLoad: async () => {
    await requireAuth();
  },
  component: ProjectsPage,
});

function ProjectsPage(): React.JSX.Element {
  return <>Projects</>;
}
