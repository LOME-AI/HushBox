import { TEST_IDS } from '@/test-ids';

/**
 * The search field sits in the header and the shortcut is registered on the
 * shell, so the two meet at the test-id registry rather than through a ref
 * drilled back up through the header. The registry is the typed contract that
 * keeps the selector from going stale silently.
 */
export function focusSearch(): void {
  const field = document.querySelector(`[data-testid="${TEST_IDS.searchInput}"]`);
  if (field instanceof HTMLElement) field.focus();
}
