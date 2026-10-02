import { registerServiceWorkerListeners } from './register-listeners.js';
import type { ServiceWorkerScope } from './handlers.js';

/**
 * Whether the global really carries the push-only surface the handlers read.
 * The entry is compiled against the DOM lib, which declares none of the service
 * worker globals, so this is the one place that claim is checked.
 */
function isServiceWorkerScope(value: unknown): value is ServiceWorkerScope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'clients' in value &&
    'registration' in value &&
    'addEventListener' in value &&
    typeof value.addEventListener === 'function'
  );
}

// Entry compiled to a stable, unhashed `/sw.js`. `globalThis` is the service
// worker global scope at runtime.
const scope: unknown = globalThis;
if (!isServiceWorkerScope(scope)) {
  throw new Error('the global this entry loaded into is not a service worker scope');
}
registerServiceWorkerListeners(scope);
