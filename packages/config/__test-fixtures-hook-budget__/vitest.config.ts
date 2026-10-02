import { defineConfig } from 'vitest/config';

// Standalone on purpose: the shared configuration is asserted directly against
// its own exported object, and this corpus exists to exercise which of two
// numbers a hook is measured against. Keeping it independent of the shared file
// lets the reader pick both numbers, and keeps this run short.
export default defineConfig({
  test: {
    name: 'hook-budget-fixture',
    environment: 'node',
    include: ['*.test.ts'],
  },
});
