import { describe, it, expect, beforeEach } from 'vitest';
import { useSearchStore } from './search';

describe('useSearchStore', () => {
  beforeEach(() => {
    useSearchStore.setState({
      webSearchEnabled: false,
    });
  });

  it('has web search disabled by default', () => {
    const { webSearchEnabled } = useSearchStore.getState();
    expect(webSearchEnabled).toBe(false);
  });

  it('toggles web search on', () => {
    useSearchStore.getState().toggleWebSearch();
    const { webSearchEnabled } = useSearchStore.getState();
    expect(webSearchEnabled).toBe(true);
  });

  it('toggles web search off after being enabled', () => {
    useSearchStore.getState().toggleWebSearch();
    useSearchStore.getState().toggleWebSearch();
    const { webSearchEnabled } = useSearchStore.getState();
    expect(webSearchEnabled).toBe(false);
  });

  it('persists search state across store calls', () => {
    useSearchStore.getState().toggleWebSearch();
    // Get fresh state
    const { webSearchEnabled } = useSearchStore.getState();
    expect(webSearchEnabled).toBe(true);
  });
});
