import { createFileRoute } from '@tanstack/react-router';
import { SharedMessagePage } from './-shared-message-page.js';

export const Route = createFileRoute('/share/m/$shareId')({
  component: SharedMessagePage,
});
