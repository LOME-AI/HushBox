import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { isDemoPath } from './lib/is-demo-path';
import { prewarmTtsIfEnabled } from './lib/prewarm-tts';
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

// The interactive product demo (embedded as a same-origin iframe on the
// marketing /welcome page) boots the real app in "demo mode": a separate lazy
// chunk installs a network shim + seeded session before mounting under a
// memory-history router. Gated on the /demo path so none of the demo bundle
// loads for real users.
if (isDemoPath(globalThis.location.pathname)) {
  const demo = await import('./demo/bootstrap');
  demo.mountDemo(rootElement);
} else {
  createRoot(rootElement).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  );

  // Fire-and-forget: returning users who already opted into read-aloud get
  // the worker/model warming in the background while they navigate. By the
  // time they send a chat, the first sentence's inference is ready to go.
  void prewarmTtsIfEnabled();
}
