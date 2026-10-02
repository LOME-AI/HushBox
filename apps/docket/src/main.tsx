import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@hushbox/ui';
import { A11yProvider, MotionProvider } from '@hushbox/ui/accessibility';
import { App } from './app';
import { ConsoleErrorFallback } from './console-error-fallback';
import { startKeepAlive } from './keep-alive';
import './app.css';

const rootElement = document.querySelector('#root');
if (!rootElement) {
  throw new Error('Root element not found');
}

startKeepAlive();

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary fallback={ConsoleErrorFallback}>
      <MotionProvider>
        <A11yProvider>
          <App />
        </A11yProvider>
      </MotionProvider>
    </ErrorBoundary>
  </StrictMode>
);
