import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import './app.css';

// Streamdown rendering styles (animation keyframes for streaming cursor)
import 'streamdown/styles.css';

// Set data-e2e on <html> before React mounts — disables all CSS transitions/animations
// via the [data-e2e] rule in app.css, eliminating timing races in E2E tests.
if (import.meta.env['VITE_E2E']) {
  document.documentElement.dataset['e2e'] = '';
}

const rootElement = document.querySelector('#root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
