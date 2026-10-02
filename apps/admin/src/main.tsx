import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import { router } from './router';
import { env } from './lib/env';
import './app.css';

const rootElement = document.querySelector('#root');
if (!rootElement) {
  throw new Error('Root element not found');
}

// @hushbox/ui derives reduced motion from the a11y store and never reads the
// build environment, so the host supplies the E2E override. It must land before
// the root is created: Playwright's prefers-reduced-motion emulation does not
// reliably reach WebKit, and a late flip would animate the first frame.
useA11yStore.getState().setForcedReducedMotion(env.isE2E);

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
