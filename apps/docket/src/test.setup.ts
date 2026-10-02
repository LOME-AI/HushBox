import '@testing-library/jest-dom/vitest';
import '@hushbox/shared/test-polyfills';

// happy-dom ships no EventSource, so the console's live sync would throw on
// mount in every test that renders the shell. The stub never emits: a test that
// cares about the stream injects its own.
if (!('EventSource' in globalThis)) {
  Object.defineProperty(globalThis, 'EventSource', {
    configurable: true,
    writable: true,
    value: class {
      addEventListener(): void {
        // Nothing ever arrives on the stub stream.
      }
      close(): void {
        // Nothing to close.
      }
    },
  });
}
